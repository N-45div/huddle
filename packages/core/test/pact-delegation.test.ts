import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { pact } from "../src/connectors/pact.ts";
import { delegationScheme } from "../src/pact/delegation.ts";
import { newKey, PactIdentity } from "../src/pact/identity.ts";
import { type SignIn, SignIns, storedGrants } from "../src/pact/signins.ts";
import { Assistant } from "../src/schema.ts";
import { Store } from "../src/store.ts";

const AUDIENCE = "http://provider.test/a2a";
const identity = new PactIdentity("http://huddle.test", newKey(), "huddle-user-1");
const brandKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
const brandJwk = { ...brandKey.publicKey.export({ format: "jwk" }), kid: "brand-1", alg: "ES256", use: "sig" };

/** A compact ES256 JWS of `claims`, signed with the business's key. */
function jws(claims: object): string {
  const head = Buffer.from(JSON.stringify({ alg: "ES256", kid: "brand-1" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign("sha256", Buffer.from(`${head}.${body}`), { key: brandKey.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${head}.${body}.${signature}`;
}

/** A business offering PACT's Delegated profile: device-code sign-in, step-up, and signed receipts. */
function delegatingProvider() {
  let base = "";
  const devices = new Map<string, { scopes: string[]; decision: "pending" | "approved" | "denied"; userCode: string }>();
  const sent: { delegation: string | undefined; contextId: string | undefined; text: string }[] = [];
  let tamper = false;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
        response.writeHead(status, { "content-type": "application/json", ...headers });
        response.end(body === undefined ? "" : JSON.stringify(body));
      };
      const path = request.url ?? "";
      const form = new URLSearchParams(raw);
      if (path === "/a2a/shop/.well-known/agent-card.json") {
        return send(200, {
          name: "Shop",
          supportedInterfaces: [{ url: `${base}/a2a/shop`, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" }],
          securitySchemes: {
            paJwt: { httpAuthSecurityScheme: { scheme: "Bearer", bearerFormat: "JWT" } },
            userDelegation: {
              oauth2SecurityScheme: {
                flows: { deviceCode: { deviceAuthorizationUrl: `${base}/oauth/device`, tokenUrl: `${base}/oauth/token`, scopes: { "orders:read": "Look up your orders", "orders:cancel": "Cancel an order that hasn't shipped" } } },
                oauth2MetadataUrl: `${base}/oauth/.well-known/oauth-authorization-server`,
              },
            },
          },
          securityRequirements: [{ schemes: { paJwt: { list: [] } } }, { schemes: { paJwt: { list: [] }, userDelegation: { list: [] } } }],
        });
      }
      if (path === "/oauth/.well-known/oauth-authorization-server") return send(200, { issuer: `${base}/oauth`, jwks_uri: `${base}/oauth/jwks` });
      if (path === "/oauth/jwks") return send(200, { keys: [brandJwk] });
      if (!(request.headers.authorization ?? "").startsWith("Bearer ey")) return send(401);
      if (path === "/oauth/device") {
        if (form.get("client_id") !== "http://huddle.test") return send(400, { error: "invalid_client" });
        const code = `dc-${devices.size + 1}`;
        const userCode = `CODE-${devices.size + 1}`;
        devices.set(code, { scopes: (form.get("scope") ?? "").split(" "), decision: "pending", userCode });
        return send(200, { device_code: code, user_code: userCode, verification_uri: `${base}/login`, verification_uri_complete: `${base}/login?code=${userCode}`, expires_in: 60, interval: 1 });
      }
      if (path === "/oauth/token") {
        const device = devices.get(form.get("device_code") ?? "");
        if (!device) return send(400, { error: "expired_token" });
        if (device.decision === "pending") return send(400, { error: "authorization_pending" });
        if (device.decision === "denied") return send(400, { error: "access_denied" });
        return send(200, { token_type: "Bearer", access_token: `token:${device.scopes.join(",")}`, refresh_token: "rt-1", expires_in: 3600, scope: device.scopes.join(" ") });
      }
      if (path === "/a2a/shop/message:send") {
        const { message } = JSON.parse(raw) as { message: { contextId?: string; parts: { text: string }[] } };
        const delegation = request.headers["x-a2a-user-delegation"] as string | undefined;
        const text = message.parts[0]!.text;
        sent.push({ delegation, contextId: message.contextId, text });
        const granted = (delegation ?? "").replace(/^Bearer token:/, "").split(",");
        if (text.includes("cancel") && !granted.includes("orders:cancel")) {
          return send(200, { task: { id: "t-up", contextId: "ctx-s", status: { state: "TASK_STATE_AUTH_REQUIRED", message: { parts: [{ text: "I need permission to cancel orders." }] } }, metadata: { "pact.missingScopes": ["orders:cancel"], "pact.verificationUriComplete": `${base}/login?step-up` } } });
        }
        const claims = { grantId: "grant-1", user: "jane", pa: "http://huddle.test", brand: `${base}/a2a/shop`, scopesUsed: text.includes("cancel") ? ["orders:cancel"] : ["orders:read"], actions: [{ tool: text.includes("cancel") ? "cancel_order" : "lookup_orders" }], ts: "2026-10-10T12:00:00Z" };
        const receipt = { jws: jws(claims), claims: tamper ? { ...claims, scopesUsed: ["refunds:issue"] } : claims };
        return send(200, { message: { messageId: "r", contextId: message.contextId ?? "ctx-s", role: "ROLE_AGENT", parts: [{ text: text.includes("cancel") ? "Order 12 is cancelled." : "Order 12 ships Friday." }], metadata: { "pact.receipt": receipt } } });
      }
      send(404);
    });
  });
  return {
    server,
    sent,
    devices,
    set base(value: string) {
      base = value;
    },
    setTamper(value: boolean) {
      tamper = value;
    },
    decide(userCode: string, decision: "approved" | "denied") {
      for (const device of devices.values()) if (device.userCode === userCode) device.decision = decision;
    },
  };
}

/** Waits for the next sign-in to show up in Approvals. */
async function nextSignIn(signIns: SignIns): Promise<SignIn> {
  for (let tries = 0; tries < 400; tries += 1) {
    const [first] = signIns.pending();
    if (first) return first;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("no sign-in showed up");
}

describe("PACT delegated authority (§5)", () => {
  const fake = delegatingProvider();
  let url = "";
  before(async () => {
    await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
    fake.base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
    url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}/a2a/shop/.well-known/agent-card.json`;
  });
  after(() => fake.server.close());

  const setup = () => {
    const store = new Store();
    const signIns = new SignIns();
    const connector = pact(() => identity, globalThis.fetch, { signIns, grants: storedGrants(store) });
    return { store, signIns, connector };
  };
  const shopper = (scopes?: string[]) => Assistant.parse({ id: "shop", connector: "pact", url, audience: AUDIENCE, ...(scopes ? { scopes } : {}) });

  it("reads a business's delegation scheme and scopes from its Agent Card", async () => {
    const card = await (await fetch(url)).json();
    const scheme = delegationScheme(card);
    assert.deepEqual(scheme?.scopes.map((scope) => scope.id), ["orders:read", "orders:cancel"]);
    assert.equal(delegationScheme({ securityRequirements: [{ schemes: { paJwt: { list: [] } } }] }), null);
  });

  it("waits in Approvals for the person to sign in on the business's page, then acts with a receipt it checks", async () => {
    const { signIns, connector, store } = setup();
    const answer = connector.send({ assistant: shopper(["orders:read"]), ask: "Where's order 12?", memory: [], runId: "run-1" });
    const signIn = await nextSignIn(signIns);
    assert.equal(signIn.business, "Shop");
    assert.deepEqual(signIn.scopes, [{ id: "orders:read", description: "Look up your orders" }]);
    assert.match(signIn.link, /\/login\?code=CODE-/);
    fake.decide(signIn.userCode, "approved");
    signIns.checkNow(signIn.id);
    const result = await answer;
    assert.equal(result.text, "Order 12 ships Friday.");
    const receipt = (result.data as { receipt: { verified: boolean; scopesUsed: string[]; actions: unknown[] } }).receipt;
    assert.equal(receipt.verified, true);
    assert.deepEqual(receipt.scopesUsed, ["orders:read"]);
    assert.equal(fake.sent.at(-1)?.delegation, "Bearer token:orders:read");
    assert.equal(signIns.pending().length, 0, "the sign-in left Approvals");
    assert.deepEqual(storedGrants(store).get(url.replace("/.well-known/agent-card.json", ""))?.scopes, ["orders:read"], "the grant was kept for next time");
  });

  it("asks only for what's missing when the business needs more, and carries on in the same conversation", async () => {
    const { signIns, connector } = setup();
    // First a grant for orders:read.
    const first = connector.send({ assistant: shopper(["orders:read"]), ask: "Where's order 12?", memory: [], runId: "run-2" });
    const one = await nextSignIn(signIns);
    fake.decide(one.userCode, "approved");
    signIns.checkNow(one.id);
    await first;
    // Then a step that needs orders:cancel: step-up, a second sign-in, the same conversation.
    const sentBefore = fake.sent.length;
    const second = connector.send({ assistant: shopper(["orders:read"]), ask: "Please cancel order 12.", memory: [], runId: "run-2" });
    const two = await nextSignIn(signIns);
    assert.deepEqual(two.scopes.map((scope) => scope.id), ["orders:read", "orders:cancel"]);
    fake.decide(two.userCode, "approved");
    signIns.checkNow(two.id);
    const result = await second;
    assert.equal(result.text, "Order 12 is cancelled.");
    const retried = fake.sent.slice(sentBefore);
    assert.equal(retried.length, 2, "asked once, then again after the sign-in");
    assert.equal(retried[1]?.contextId, "ctx-s", "in the same conversation");
    assert.equal(retried[1]?.delegation, "Bearer token:orders:read,orders:cancel");
    assert.equal((result.data as { receipt: { verified: boolean } }).receipt.verified, true);
  });

  it("flags a receipt whose claims don't match what the business signed", async () => {
    const { signIns, connector } = setup();
    fake.setTamper(true);
    try {
      const answer = connector.send({ assistant: shopper(["orders:read"]), ask: "Where's order 12?", memory: [], runId: "run-3" });
      const signIn = await nextSignIn(signIns);
      fake.decide(signIn.userCode, "approved");
      signIns.checkNow(signIn.id);
      const receipt = ((await answer).data as { receipt: { verified: boolean; problem: string } }).receipt;
      assert.equal(receipt.verified, false);
      assert.match(receipt.problem, /don't match what was signed/);
    } finally {
      fake.setTamper(false);
    }
  });

  it("stops with a plain reason when the person says no, or cancels the sign-in", async () => {
    const { signIns, connector } = setup();
    const denied = connector.send({ assistant: shopper(["orders:read"]), ask: "Where's order 12?", memory: [], runId: "run-4" });
    const one = await nextSignIn(signIns);
    fake.decide(one.userCode, "denied");
    signIns.checkNow(one.id);
    await assert.rejects(denied, /You said no on Shop's page/);

    const cancelled = connector.send({ assistant: shopper(["orders:read"]), ask: "Where's order 12?", memory: [], runId: "run-5" });
    const two = await nextSignIn(signIns);
    signIns.cancel(two.id);
    await assert.rejects(cancelled, /You cancelled signing in to Shop/);
    assert.equal(signIns.pending().length, 0);
  });

  it("without sign-ins set up, hands the step-up back as state for the flow to branch on", async () => {
    const connector = pact(() => identity);
    const result = await connector.send({ assistant: shopper(), ask: "Please cancel order 12.", memory: [], runId: "run-6" });
    assert.equal((result.data as { state: string }).state, "auth_required");
    assert.deepEqual((result.data as { missingScopes: string[] }).missingScopes, ["orders:cancel"]);
  });
});
