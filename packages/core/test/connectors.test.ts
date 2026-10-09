import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { http } from "../src/connectors/http.ts";
import { mock } from "../src/connectors/mock.ts";
import { sochen } from "../src/connectors/sochen.ts";
import type { Note } from "../src/store.ts";
import { Assistant } from "../src/schema.ts";

const note: Note = { id: "note_1", slice: "money", note: "Rent is due on the 5th.", status: "kept", source: "you", createdAt: "" };

describe("the mock connector", () => {
  it("answers from its replies, the first matching key winning, and passes JSON on as data", async () => {
    const assistant = Assistant.parse({ id: "m", connector: "mock", replies: { invoice: '{"amount": 5}', "*": "fallback" } });
    assert.deepEqual(await mock.send({ assistant, ask: "Read this INVOICE", memory: [] }), { text: '{"amount": 5}', data: { amount: 5 } });
    assert.deepEqual(await mock.send({ assistant, ask: "something else", memory: [] }), { text: "fallback" });
  });
});

describe("the http connector", () => {
  const received: { auth?: string; body: unknown }[] = [];
  let url = "";
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      received.push({ auth: request.headers.authorization, body: JSON.parse(raw) });
      response.setHeader("content-type", "application/json");
      if (request.url === "/fail") {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: "bad key secret-123" }));
      } else {
        response.end(JSON.stringify({ text: "Done. ```json\n{\"ok\": true}\n```" }));
      }
    });
  });
  before(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)));
  before(() => {
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.HUDDLE_TEST_KEY = "secret-123";
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("posts the request and the memory it may see, with its key, and finds the data in the answer", async () => {
    const assistant = Assistant.parse({ id: "h", connector: "http", url, keyEnv: "HUDDLE_TEST_KEY" });
    const answer = await http().send({ assistant, ask: "Book it", memory: [note] });
    assert.deepEqual(answer, { text: "Done. ```json\n{\"ok\": true}\n```", data: { ok: true } });
    assert.equal(received[0]?.auth, "Bearer secret-123");
    assert.deepEqual(received[0]?.body, { ask: "Book it", memory: [{ slice: "money", note: "Rent is due on the 5th." }] });
  });

  it("never repeats the key in an error", async () => {
    const assistant = Assistant.parse({ id: "h", connector: "http", url: `${url}/fail`, keyEnv: "HUDDLE_TEST_KEY" });
    await assert.rejects(http().send({ assistant, ask: "x", memory: [] }), (error: Error) => {
      assert.equal(error.message, "h said: bad key [key]");
      return true;
    });
  });
});

describe("the Sochen connector", () => {
  const assistant = Assistant.parse({ id: "sochen", connector: "sochen" });
  const answering = (body: unknown, status = 200) => (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Response.json(body, { status });
  }) as typeof fetch;
  const calls: { url: string; init?: RequestInit }[] = [];

  it("asks Sochen's Agent API with the key from SOCHEN_API_KEY, the memory added to the message", async () => {
    process.env.SOCHEN_API_KEY = "sk_sochen_test";
    const answer = await sochen(answering({ status: "answered", answer: "Three homes found.", chat_id: "wrun_1" })).send({ assistant, ask: "Find homes", memory: [note] });
    assert.equal(calls[0]?.url, "https://sochen.dev/api/v1/run");
    assert.equal((calls[0]?.init?.headers as Record<string, string>).authorization, "Bearer sk_sochen_test");
    assert.match(JSON.parse(String(calls[0]?.init?.body)).message, /Find homes\n\nWhat you may use about me:\n- \(money\) Rent is due on the 5th\./);
    assert.deepEqual(answer, { text: "Three homes found.", data: { status: "answered", chat: "wrun_1" } });
  });

  it("passes on Sochen's own note when it's waiting for its person's OK or still working", async () => {
    const waiting = await sochen(answering({ status: "needs_approval", answer: null, note: "Sochen needs the person's OK before it can pay; approve it in the app.", chat_id: "wrun_2" })).send({ assistant, ask: "Pay it", memory: [] });
    assert.equal(waiting.text, "Sochen needs the person's OK before it can pay; approve it in the app.");
    assert.deepEqual(waiting.data, { status: "needs_approval", chat: "wrun_2" });
  });

  it("says which variable is missing, and never repeats the key in an error", async () => {
    delete process.env.SOCHEN_API_KEY;
    await assert.rejects(sochen(answering({})).send({ assistant, ask: "x", memory: [] }), /SOCHEN_API_KEY environment variable/);
    process.env.SOCHEN_API_KEY = "sk_sochen_test";
    await assert.rejects(sochen(answering({ error: "key sk_sochen_test is not Pro" }, 403)).send({ assistant, ask: "x", memory: [] }), /Sochen said: key \[key\] is not Pro/);
  });
});
