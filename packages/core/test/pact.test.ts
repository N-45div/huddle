import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { pact } from "../src/connectors/pact.ts";
import { newKey, PactIdentity, thumbprint } from "../src/pact/identity.ts";
import { Assistant } from "../src/schema.ts";
import { Store } from "../src/store.ts";

const AUDIENCE = "http://provider.test/a2a";
const identity = new PactIdentity("http://huddle.test/", newKey(), "huddle-user-1");

/** Checks a personal-agent JWT the way PACT §3.2 says a Provider must; returns its claims or a reason it fails. */
function check(token: string, jwk = identity.publicJwk()): Record<string, unknown> | string {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return "not a JWT";
  const head = JSON.parse(Buffer.from(header, "base64url").toString()) as { alg?: string; kid?: string };
  if (head.alg !== "ES256" || head.kid !== jwk.kid) return "wrong alg or kid";
  const good = verify("sha256", Buffer.from(`${header}.${payload}`), { key: createPublicKey({ key: { ...jwk }, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
  if (!good) return "bad signature";
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, number | string>;
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== "http://huddle.test" || claims.aud !== AUDIENCE || !claims.sub) return "wrong iss, aud or sub";
  if (Number(claims.iat) > now + 30 || Number(claims.exp) - Number(claims.iat) > 300 || Number(claims.exp) < now) return "bad times";
  return claims;
}

/** A business's Provider as PACT 1.0 describes it: card, message:send, contexts, a closed one, a rate limit, a sign-in. */
function fakeProvider() {
  const seen: { contextId?: string; text: string; sub?: unknown }[] = [];
  let base = "";
  let limited = false;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
        response.writeHead(status, { "content-type": "application/a2a+json", ...headers });
        response.end(body === undefined ? "" : JSON.stringify(body));
      };
      const path = request.url ?? "";
      if (request.method === "GET" && path === "/a2a/loom/.well-known/agent-card.json") {
        return send(200, { name: "Loom & Co.", supportedInterfaces: [{ url: `${base}/a2a/loom`, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" }] });
      }
      if (request.method === "GET" && path === "/a2a/old/.well-known/agent-card.json") return send(200, { name: "Old Co.", supportedInterfaces: [{ url: `${base}/rpc`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }] });
      if (request.method === "GET") return send(404);
      if (path !== "/a2a/loom/message:send") return send(404);
      const claims = check((request.headers.authorization ?? "").replace(/^Bearer /, ""));
      if (typeof claims === "string" || request.headers["a2a-version"] !== "1.0") return send(401, undefined, { "www-authenticate": 'Bearer realm="a2a"' });
      const { message } = JSON.parse(raw) as { message: { contextId?: string; role: string; parts: { text: string }[] } };
      const text = message.parts[0]!.text;
      seen.push({ contextId: message.contextId, text, sub: claims.sub });
      if (text.includes("busy") && !limited) {
        limited = true;
        return send(429, undefined, { "retry-after": "0" });
      }
      if (message.contextId === "ctx-closed") return send(400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "Conversation closed.", details: [{ reason: "UNSUPPORTED_OPERATION" }] } });
      if (text.includes("account")) {
        return send(200, { task: { id: "task-9", contextId: "ctx-9", status: { state: "TASK_STATE_AUTH_REQUIRED", message: { role: "ROLE_AGENT", parts: [{ text: "Please sign in with Loom & Co." }] } }, metadata: { "pact.missingScopes": ["orders:read"], "pact.verificationUriComplete": "http://provider.test/device?code=ABCD" } } });
      }
      if (message.contextId === "ctx-1" && text.includes("4471")) return send(200, { message: { messageId: "r2", contextId: "ctx-1", role: "ROLE_AGENT", parts: [{ text: "Order 4471 ships on Friday." }] } });
      return send(200, { message: { messageId: "r1", contextId: text.includes("goodbye") ? "ctx-closed" : "ctx-1", role: "ROLE_AGENT", parts: [{ text: "Sure, what's the order number?" }] } });
    });
  });
  return { seen, server, get base() { return base; }, set base(value: string) { base = value; } };
}

describe("PACT", () => {
  const fake = fakeProvider();
  before(() => new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve)));
  before(() => {
    fake.base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => fake.server.close(() => resolve())));
  const loom = (fields: Record<string, unknown> = {}) => Assistant.parse({ id: "loom", connector: "pact", url: `${fake.base}/a2a/loom/.well-known/agent-card.json`, audience: AUDIENCE, ...fields });

  it("signs short-lived ES256 tokens a Provider can check against Huddle's published key", () => {
    const claims = check(identity.sign({ aud: AUDIENCE }));
    assert.notEqual(typeof claims, "string", String(claims));
    assert.deepEqual([(claims as Record<string, unknown>).iss, (claims as Record<string, unknown>).sub], ["http://huddle.test", "huddle-user-1"]);
    assert.equal(identity.jwks().keys[0]!.kid, thumbprint(identity.publicJwk()));
    assert.equal("d" in identity.jwks().keys[0]!, false, "the private part never leaves");
    assert.equal(identity.jwksUri, "http://huddle.test/.well-known/jwks.json");
    assert.throws(() => identity.sign({ aud: AUDIENCE, ttlSeconds: 301 }), /between 1 and 300 seconds/);
    const other = new PactIdentity("http://huddle.test", newKey(), "x");
    assert.equal(check(other.sign({ aud: AUDIENCE })), "wrong alg or kid", "someone else's key doesn't pass");
  });

  it("keeps the same key and the same opaque person across restarts", () => {
    const store = new Store();
    const first = PactIdentity.load(store, "http://huddle.test");
    const again = PactIdentity.load(store, "http://huddle.test");
    assert.deepEqual(again.publicJwk(), first.publicJwk());
    assert.equal(again.subject, first.subject);
    assert.match(first.subject, /^huddle-[0-9a-f]{24}$/);
  });

  it("talks to a business's agent and carries the conversation across a run's steps", async () => {
    const connector = pact(() => identity);
    const asked = await connector.send({ assistant: loom(), ask: "Where is my order?", memory: [], runId: "run-1" });
    assert.equal(asked.text, "Sure, what's the order number?");
    assert.deepEqual(asked.data, { state: "completed", business: "Loom & Co.", context: "ctx-1" });
    const answered = await connector.send({ assistant: loom(), ask: "It's 4471.", memory: [], runId: "run-1" });
    assert.equal(answered.text, "Order 4471 ships on Friday.");
    assert.equal(fake.seen.at(-1)?.contextId, "ctx-1", "the second step continued the conversation");
    await connector.send({ assistant: loom(), ask: "Where is my order?", memory: [], runId: "run-2" });
    assert.equal(fake.seen.at(-1)?.contextId, undefined, "another run starts its own");
    assert.equal(fake.seen.at(-1)?.sub, "huddle-user-1");
  });

  it("waits out a rate limit, and starts a new conversation when the business closed the old one", async () => {
    const connector = pact(() => identity);
    const started = Date.now();
    assert.equal((await connector.send({ assistant: loom(), ask: "busy?", memory: [], runId: "run-3" })).text, "Sure, what's the order number?");
    assert.ok(Date.now() - started < 1_000, "Retry-After: 0 means right away");
    // The business hands this run a conversation it then closes.
    await connector.send({ assistant: loom(), ask: "goodbye", memory: [], runId: "run-4" });
    const before = fake.seen.length;
    const reply = await connector.send({ assistant: loom(), ask: "hello again", memory: [], runId: "run-4" });
    assert.deepEqual(fake.seen.slice(before).map((request) => request.contextId), ["ctx-closed", undefined], "tried the old one, then started afresh");
    assert.equal(reply.text, "Sure, what's the order number?");
  });

  it("hands back a sign-in the business needs as state, with the link and the scopes", async () => {
    const answer = await pact(() => identity).send({ assistant: loom(), ask: "Show my account", memory: [], runId: "run-5" });
    assert.equal(answer.text, "Please sign in with Loom & Co. Sign in here: http://provider.test/device?code=ABCD");
    assert.deepEqual(answer.data, { state: "auth_required", business: "Loom & Co.", signIn: "http://provider.test/device?code=ABCD", missingScopes: ["orders:read"], task: "task-9" });
  });

  it("says what to fix: an identity the business turned down, a card with no PACT interface, no card at all", async () => {
    const stranger = new PactIdentity("http://huddle.test", newKey(), "x");
    await assert.rejects(pact(() => stranger).send({ assistant: loom(), ask: "hi", memory: [] }), /Loom & Co\. turned down Huddle's identity \(401\)\. Register Huddle with its Provider \(issuer http:\/\/huddle\.test, keys at http:\/\/huddle\.test\/\.well-known\/jwks\.json\)/);
    await assert.rejects(pact(() => identity).send({ assistant: loom({ url: `${fake.base}/a2a/old/.well-known/agent-card.json` }), ask: "hi", memory: [] }), /has no A2A HTTP\+JSON 1\.0 interface, so it doesn't speak PACT/);
    await assert.rejects(pact(() => identity).send({ assistant: loom({ url: `${fake.base}/a2a/nobody/.well-known/agent-card.json` }), ask: "hi", memory: [] }), /There's no agent at .* \(404\)/);
  });
});
