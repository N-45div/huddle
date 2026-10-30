import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { fingerprint } from "../src/countersign.ts";
import { type Change, Store } from "../src/store.ts";

/** A board's raw public key, as it sends it. */
function boardKey(): string {
  const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
}

describe("boards that sign", () => {
  it("are kept by their key, pinned once, with a fingerprint to compare", () => {
    const store = new Store();
    const key = boardKey();
    const board = store.addSigner({ key, name: "Desk button", deviceId: "device_1" });
    assert.equal(board.fingerprint, fingerprint(key));
    assert.equal(store.signer(key)?.name, "Desk button");
    assert.equal(store.signerForDevice("device_1")?.key, key);
    // The same key again, or another key for the same device, isn't taken: a board's key can't be swapped quietly.
    assert.throws(() => store.addSigner({ key, name: "Again" }), /already added/);
    assert.throws(() => store.addSigner({ key: boardKey(), name: "Impostor", deviceId: "device_1" }), /already added/);
    // Boards in a browser have no device.
    store.addSigner({ key: boardKey(), name: "Virtual board" });
    assert.equal(store.signers().length, 2);
    assert.equal(store.removeSigner(key), true);
    assert.equal(store.signer(key), null);
  });
});

describe("what's waiting for a board's signature", () => {
  const request = { id: "pay_00112233445566778899aabb", kind: "buy" as const, text: '{"v":1}', runId: "run_1", stepId: "pay", shop: "http://shop.test", expires: "2026-10-30T10:15:00Z" };

  it("is signed once, then moves on as the shop answers", () => {
    const store = new Store();
    const changes: Change[] = [];
    store.events.on("change", (change: Change) => changes.push(change));
    const key = boardKey();
    store.addSigner({ key, name: "Desk button" });
    const added = store.addSignRequest(request);
    assert.equal(added.status, "waiting");
    assert.deepEqual(store.waitingSignRequests().map((one) => one.id), [request.id]);
    assert.equal(store.markSigned(request.id, "sig", key), true);
    assert.equal(store.markSigned(request.id, "sig-again", key), false, "a second signature doesn't replace the first");
    const signed = store.signRequest(request.id)!;
    assert.equal(signed.status, "signed");
    assert.equal(signed.signature, "sig");
    assert.ok(store.signer(key)?.lastSignedAt);
    assert.equal(store.moveSignRequest(request.id, "signed", { status: "paid", result: { order: "order_1" } }), true);
    assert.equal(store.moveSignRequest(request.id, "signed", { status: "failed", error: "late" }), false);
    assert.deepEqual(store.signRequest(request.id)?.result, { order: "order_1" });
    assert.deepEqual(store.waitingSignRequests(), []);
    assert.ok(changes.some((change) => change.kind === "sign" && change.runId === "run_1"));
  });

  it("is found by its run and step, the latest first", () => {
    const store = new Store();
    store.addSignRequest(request);
    store.moveSignRequest(request.id, "waiting", { status: "expired" });
    store.addSignRequest({ ...request, id: "pay_99887766554433221100ffee" });
    assert.equal(store.signRequestFor("run_1", "pay")?.id, "pay_99887766554433221100ffee");
    assert.equal(store.signRequestFor("run_1", "other"), null);
  });

  it("holds an approval that only the signature answers yes to", () => {
    const store = new Store();
    const approval = store.addApproval("run_1", "pay", "Pay $32.50 to Bean & Leaf", null, null, request.id);
    assert.equal(approval.signs, request.id);
    assert.equal(store.approval(approval.id)?.signs, request.id);
    assert.equal(store.approvalForSign(request.id)?.id, approval.id);
    assert.equal(store.addApproval("run_1", "ok", "Send it?").signs, null);
  });
});
