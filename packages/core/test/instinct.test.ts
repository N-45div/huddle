import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { instinct } from "../src/connectors/instinct.ts";
import { Engine } from "../src/engine.ts";
import { Assistant, parseFlow } from "../src/schema.ts";
import { type Note, Store } from "../src/store.ts";

const TOKEN = "chat-token-123";
const STILL_WORKING = "On it. This is taking a moment; send another message in a bit and I will have the answer here.";
const note: Note = { id: "note_1", slice: "food", note: "We're vegetarian.", status: "kept", source: "you", createdAt: "" };

/**
 * A stand-in open-instinct agent, answering the way its server (packages/server/src/http.ts) does: owner
 * chat on "chat:<conversation_id>", 401 without its token (Bearer or X-Instinct-Token), "On it" past its
 * reply budget, and the late answer in `pending` on that conversation's next /chat.
 */
function fakeInstinct() {
  const calls: { auth?: string; body: { message: string; source?: string; conversation_id?: string } }[] = [];
  const said = new Map<string, string[]>();
  const late = new Map<string, string[]>();
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const reply = (status: number, body: unknown) => {
        response.statusCode = status;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(body));
      };
      if (request.url?.startsWith("/web/")) {
        response.setHeader("content-type", "text/html");
        return response.end("<!doctype html><title>Not an agent</title>");
      }
      const auth = request.headers.authorization;
      const presented = auth?.replace(/^Bearer\s+/i, "") ?? request.headers["x-instinct-token"];
      if (presented !== TOKEN) return reply(401, { error: "missing or invalid token" });
      if (request.method !== "POST" || request.url !== "/chat") return reply(404, { error: "not found" });
      const body = JSON.parse(raw) as { message: string; source?: string; conversation_id?: string };
      calls.push({ auth, body });
      const conversationKey = `chat:${body.conversation_id ?? "default"}`;
      const history = [...(said.get(conversationKey) ?? []), body.message];
      said.set(conversationKey, history);
      const pending = late.get(conversationKey);
      late.delete(conversationKey);
      const answer = (text: string) => reply(200, { response: text, acked: true, conversationKey, ...(pending ? { pending } : {}) });
      if (body.message.startsWith("Find flights")) {
        late.set(conversationKey, ["Three flights to Lisbon under $400."]);
        return answer(STILL_WORKING);
      }
      if (body.message.startsWith("Book dinner")) return answer("For how many?");
      if (body.message.startsWith("Four")) return answer(history.some((m) => m.startsWith("Book dinner")) ? '{"booked": true, "people": 4}' : "Four what?");
      return answer("Nothing else yet.");
    });
  });
  return { calls, server };
}

describe("open-instinct", () => {
  const fake = fakeInstinct();
  let base = "";
  const saved = process.env.INSTINCT_CHAT_TOKEN;
  before(() => new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve)));
  before(() => {
    base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
    process.env.TEST_INSTINCT_TOKEN = TOKEN;
    delete process.env.INSTINCT_CHAT_TOKEN;
  });
  after(() => new Promise<void>((resolve) => fake.server.close(() => resolve())));
  after(() => {
    delete process.env.TEST_INSTINCT_TOKEN;
    if (saved === undefined) delete process.env.INSTINCT_CHAT_TOKEN;
    else process.env.INSTINCT_CHAT_TOKEN = saved;
  });
  const agent = (fields: Record<string, unknown> = {}) => Assistant.parse({ id: "maria", connector: "instinct", url: base, keyEnv: "TEST_INSTINCT_TOKEN", ...fields });

  it("asks as its owner, from Huddle, with the token and the memory under the request", async () => {
    const answer = await instinct().send({ assistant: agent({ url: `${base}/chat/` }), ask: "Book dinner tonight.", memory: [note], runId: "run_1" });
    assert.deepEqual(answer, { text: "For how many?", data: { state: "completed", conversation: "huddle-run_1-maria" } });
    const sent = fake.calls.at(-1)!;
    assert.equal(sent.auth, `Bearer ${TOKEN}`);
    assert.deepEqual(sent.body, { message: "Book dinner tonight.\n\nWhat you may use about me:\n- (food) We're vegetarian.", source: "huddle", conversation_id: "huddle-run_1-maria" });
  });

  it("carries one conversation through a run's steps, and starts another for the next run", async () => {
    const flow = parseFlow({
      name: "Dinner",
      assistants: [{ id: "maria", connector: "instinct", url: base, keyEnv: "TEST_INSTINCT_TOKEN" }],
      steps: [
        { id: "ask", type: "agent", agent: "maria", ask: "Book dinner tonight." },
        { id: "answer", type: "agent", agent: "maria", ask: "Four of us. Answer as JSON." },
      ],
    });
    const engine = new Engine(new Store(), { instinct: instinct() });
    const first = await engine.start(flow, "");
    assert.equal(first.state, "done", first.error ?? "");
    assert.equal(first.context.steps.ask?.text, "For how many?");
    assert.deepEqual(first.context.steps.answer?.data, { booked: true, people: 4, state: "completed", conversation: `huddle-${first.id}-maria` });
    const second = await engine.start(flow, "");
    const ids = fake.calls.slice(-4).map((call) => call.body.conversation_id);
    assert.deepEqual(ids, [`huddle-${first.id}-maria`, `huddle-${first.id}-maria`, `huddle-${second.id}-maria`, `huddle-${second.id}-maria`]);
    assert.notEqual(first.id, second.id);
  });

  it("says when it's still working, and hands the late answer to the next step as pending", async () => {
    const connector = instinct();
    const working = await connector.send({ assistant: agent(), ask: "Find flights to Lisbon in May.", memory: [], runId: "run_2" });
    assert.deepEqual(working, { text: STILL_WORKING, data: { state: "working", conversation: "huddle-run_2-maria" } });
    const next = await connector.send({ assistant: agent(), ask: "Any news?", memory: [], runId: "run_2" });
    assert.deepEqual(next, { text: "Nothing else yet.", data: { state: "completed", conversation: "huddle-run_2-maria", pending: ["Three flights to Lisbon under $400."] } });
  });

  it("says what to fix: a wrong token, a missing one, an address that isn't open-instinct", async () => {
    process.env.TEST_INSTINCT_WRONG = "not-the-token";
    await assert.rejects(instinct().send({ assistant: agent({ keyEnv: "TEST_INSTINCT_WRONG" }), ask: "hi", memory: [] }), /maria turned down the token \(401\): TEST_INSTINCT_WRONG here doesn't match the agent's INSTINCT_CHAT_TOKEN\./);
    delete process.env.TEST_INSTINCT_WRONG;
    await assert.rejects(instinct().send({ assistant: agent({ keyEnv: undefined }), ask: "hi", memory: [] }), /maria wants a token \(401\): set INSTINCT_CHAT_TOKEN where Huddle runs/);
    process.env.INSTINCT_CHAT_TOKEN = TOKEN;
    assert.equal((await instinct().send({ assistant: agent({ keyEnv: undefined }), ask: "Book dinner", memory: [] })).text, "For how many?", "INSTINCT_CHAT_TOKEN is used when keyEnv names none");
    delete process.env.INSTINCT_CHAT_TOKEN;
    await assert.rejects(instinct().send({ assistant: agent({ keyEnv: "TEST_INSTINCT_UNSET" }), ask: "hi", memory: [] }), /needs its key in the TEST_INSTINCT_UNSET environment variable/);
    await assert.rejects(instinct().send({ assistant: agent({ url: `${base}/web/` }), ask: "hi", memory: [] }), /maria answered with something that isn't JSON\. Is http:\/\/127\.0\.0\.1:\d+\/web an open-instinct agent\?/);
    await assert.rejects(instinct().send({ assistant: agent({ url: `${base}/agent` }), ask: "hi", memory: [] }), /maria said: not found\. Is .*\/agent an open-instinct agent\?/);
    await assert.rejects(instinct().send({ assistant: agent(), ask: '@@instinct-event@@{"type": "message.received"}', memory: [] }), /starts with @@instinct-event@@/);
  });

  it("says open-instinct isn't running when nothing answers, and how to start it", async () => {
    // A port that was just free, so the connection is refused (fetch won't even try port 9).
    const spare = createServer();
    await new Promise<void>((resolve) => spare.listen(0, "127.0.0.1", resolve));
    const port = (spare.address() as AddressInfo).port;
    await new Promise<void>((resolve) => spare.close(() => resolve()));
    const closed = Assistant.parse({ id: "maria", connector: "instinct", url: `http://127.0.0.1:${port}` });
    await assert.rejects(
      instinct().send({ assistant: closed, ask: "hi", memory: [] }),
      (error: Error) => error.message === `maria: Can't reach open-instinct at http://127.0.0.1:${port}. Is it running? Start it in its folder with: pnpm instinct dev`,
    );
  });
});
