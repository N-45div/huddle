import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { a2a } from "../src/connectors/a2a.ts";
import { openai } from "../src/connectors/openai.ts";
import { Assistant } from "../src/schema.ts";
import type { Note } from "../src/store.ts";

const note: Note = { id: "note_1", slice: "work", note: "Standup is at 10.", status: "kept", source: "you", createdAt: "" };
/** A chat reply with its data in a ```json block, the way assistants hand back structured output. */
const CHAT_REPLY = ["Done.", "```json", '{"booked": true}', "```"].join("\n");

interface Call {
  readonly path: string;
  readonly auth?: string;
  readonly body: { method?: string; params?: { message?: { role?: string; parts?: { text?: string }[] }; id?: string } } & Record<string, unknown>;
}

/** A local stand-in for real assistants: OpenClaw-like (card, /a2a/v1), Hermes-like (no card, JSON-RPC at /), and OpenAI-style chat. */
function fakeAgents() {
  const calls: Call[] = [];
  let polls = 0;
  let base = "";
  const reply = (response: ServerResponse, body: unknown, status = 200) => {
    response.statusCode = status;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const path = request.url ?? "/";
      if (request.method === "GET" && path === "/claw/.well-known/agent-card.json") {
        return reply(response, { name: "OpenClaw", supportedInterfaces: [{ url: `${base}/claw/a2a/v1`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }] });
      }
      if (request.method === "GET") return reply(response, { error: "not found" }, 404);
      const body = JSON.parse(raw || "{}") as Call["body"];
      calls.push({ path, auth: request.headers.authorization, body });
      if (path === "/claw/a2a/v1" && body.method === "SendMessage") {
        return reply(response, { jsonrpc: "2.0", id: body.id, result: { task: { id: "t1", contextId: "c1", status: { state: "TASK_STATE_WORKING" } } } });
      }
      if (path === "/claw/a2a/v1" && body.method === "GetTask") {
        polls += 1;
        const task =
          polls < 2
            ? { id: "t1", contextId: "c1", status: { state: "TASK_STATE_WORKING" } }
            : { id: "t1", contextId: "c1", status: { state: "TASK_STATE_COMPLETED" }, artifacts: [{ parts: [{ text: "Moved standup to 11." }, { data: { moved: true } }] }] };
        return reply(response, { jsonrpc: "2.0", id: body.id, result: task });
      }
      if (path === "/hermes/") {
        const text = body.params?.message?.parts?.[0]?.text ?? "";
        if (text.includes("fail")) return reply(response, { jsonrpc: "2.0", id: body.id, result: { task: { id: "t3", status: { state: "TASK_STATE_REJECTED", message: { parts: [{ text: "Not allowed." }] } } } } });
        if (text.includes("secret")) return reply(response, { jsonrpc: "2.0", id: body.id, error: { code: -32001, message: "bad token tok-hermes" } });
        return reply(response, { jsonrpc: "2.0", id: body.id, result: { task: { id: "t2", contextId: "c2", status: { state: "TASK_STATE_INPUT_REQUIRED", message: { parts: [{ text: "Which calendar?" }] } } } } });
      }
      // What the real ones did when we ran them: OpenClaw turns away the 2nd call here (its limit is 30 a minute) and
      // answers a bad token with a plain {"error"} and a 401; Hermes, just started, closes a task with nothing in it.
      if (path === "/busy/") {
        if (calls.filter((call) => call.path === "/busy/").length === 2) return reply(response, { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "Peer is rate limited" } });
        return reply(response, { jsonrpc: "2.0", id: body.id, result: { message: { role: "ROLE_AGENT", parts: [{ text: "pong" }] } } });
      }
      if (path === "/locked/") return reply(response, { error: "Unauthorized; configure channels.a2a.peers with a matching Bearer token" }, 401);
      if (path === "/silent/") return reply(response, { jsonrpc: "2.0", id: body.id, result: { task: { id: "t4", contextId: "c4", status: { state: "TASK_STATE_COMPLETED" }, artifacts: [] } } });
      if (path === "/v1/chat/completions") return reply(response, { choices: [{ message: { content: CHAT_REPLY } }] });
      return reply(response, { error: "unknown" }, 404);
    });
  });
  return {
    calls,
    server,
    get base() { return base; },
    set base(value: string) { base = value; },
  };
}

describe("A2A agents (OpenClaw, Hermes and any other)", () => {
  const fake = fakeAgents();
  before(() => new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve)));
  before(() => { fake.base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`; });
  after(() => new Promise<void>((resolve) => fake.server.close(() => resolve())));

  it("finds the endpoint on the Agent Card, sends the request with its memory, and polls a working task to the end", async () => {
    process.env.OPENCLAW_A2A_TOKEN = "tok-claw";
    const assistant = Assistant.parse({ id: "claw", connector: "openclaw", url: `${fake.base}/claw` });
    const answer = await a2a(fetch, { pollMs: 5 }).send({ assistant, ask: "Move standup", memory: [note] });
    assert.deepEqual(answer, { text: "Moved standup to 11.", data: { moved: true, state: "completed", task: "t1", context: "c1" } });
    const sent = fake.calls.find((call) => call.body.method === "SendMessage")!;
    assert.equal(sent.path, "/claw/a2a/v1", "the card's JSON-RPC interface");
    assert.equal(sent.auth, "Bearer tok-claw", "the preset's token variable");
    assert.equal(sent.body.params?.message?.role, "ROLE_USER");
    assert.match(sent.body.params?.message?.parts?.[0]?.text ?? "", /Move standup\n\nWhat you may use about me:\n- \(work\) Standup is at 10\./);
    assert.equal(fake.calls.filter((call) => call.body.method === "GetTask").length, 2);
  });

  it("talks to an agent with no card at its own address, and hands back a task that needs input as its state", async () => {
    const assistant = Assistant.parse({ id: "hermes", connector: "hermes", url: `${fake.base}/hermes/` });
    const answer = await a2a(fetch, { pollMs: 5 }).send({ assistant, ask: "Add it to my calendar", memory: [] });
    assert.deepEqual(answer, { text: "Which calendar?", data: { state: "input_required", task: "t2", context: "c2" } });
    assert.equal(fake.calls.at(-1)?.auth, undefined, "no token unless one is set");
  });

  it("makes a rejected task an error, and never repeats the token in one", async () => {
    const assistant = Assistant.parse({ id: "hermes", connector: "hermes", url: `${fake.base}/hermes/`, keyEnv: "HERMES_TOKEN" });
    process.env.HERMES_TOKEN = "tok-hermes";
    const connector = a2a(fetch, { pollMs: 5 });
    await assert.rejects(connector.send({ assistant, ask: "please fail", memory: [] }), /hermes's task rejected: Not allowed\./);
    await assert.rejects(connector.send({ assistant, ask: "secret", memory: [] }), (error: Error) => {
      assert.equal(error.message, "hermes said: bad token [key] (-32001)");
      return true;
    });
    delete process.env.HERMES_TOKEN;
    await assert.rejects(connector.send({ assistant, ask: "x", memory: [] }), /HERMES_TOKEN environment variable/);
  });

  it("waits and tries again when an agent says it's rate limited, instead of failing the step", async () => {
    const assistant = Assistant.parse({ id: "busy", connector: "a2a", url: `${fake.base}/busy/` });
    const connector = a2a(fetch, { pollMs: 5 });
    assert.equal((await connector.send({ assistant, ask: "ping", memory: [] })).text, "pong");
    assert.equal((await connector.send({ assistant, ask: "ping", memory: [] })).text, "pong", "the limited call, sent again");
    assert.equal(fake.calls.filter((call) => call.path === "/busy/").length, 3);
  });

  it("says why an agent refused, even when it doesn't answer in JSON-RPC", async () => {
    const assistant = Assistant.parse({ id: "claw", connector: "a2a", url: `${fake.base}/locked/` });
    await assert.rejects(a2a(fetch, { pollMs: 5 }).send({ assistant, ask: "ping", memory: [] }), /claw said: Unauthorized; configure channels\.a2a\.peers with a matching Bearer token \(HTTP 401\)/);
  });

  it("makes a finished task with no answer an error, not an empty answer", async () => {
    const assistant = Assistant.parse({ id: "hermes", connector: "a2a", url: `${fake.base}/silent/` });
    await assert.rejects(a2a(fetch, { pollMs: 5 }).send({ assistant, ask: "ping", memory: [] }), /hermes finished task t4 without an answer\. If it had only just started, run this again\./);
  });

  it("speaks the OpenAI chat format too, with the memory as a system note", async () => {
    const assistant = Assistant.parse({ id: "webui", connector: "openai", url: fake.base, model: "openclaw/main" });
    const answer = await openai().send({ assistant, ask: "Book the room", memory: [note] });
    assert.deepEqual(answer, { text: CHAT_REPLY, data: { booked: true } });
    const sent = fake.calls.at(-1)!;
    assert.equal(sent.path, "/v1/chat/completions");
    assert.equal(sent.body.model, "openclaw/main");
    assert.deepEqual(sent.body.messages, [
      { role: "system", content: "What you may use about the person:\n- (work) Standup is at 10." },
      { role: "user", content: "Book the room" },
    ]);
  });
});
