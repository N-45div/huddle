import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { ollama, ollamaModels } from "../src/connectors/ollama.ts";
import { Assistant } from "../src/schema.ts";
import type { Note } from "../src/store.ts";

const note: Note = { id: "note_1", slice: "home", note: "My cat is called Miso.", status: "kept", source: "you", createdAt: "" };

/** A stand-in Ollama, answering the way a real one (0.40) did: native /api/chat, {"error": "..."} on failure. */
function fakeOllama() {
  const calls: { path: string; auth?: string; body: Record<string, unknown> }[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const reply = (status: number, body: unknown) => {
        response.statusCode = status;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(body));
      };
      const path = request.url ?? "/";
      if (request.method === "GET" && path === "/api/tags") return reply(200, { models: [{ name: "qwen3:latest" }, { name: "gemma3:270m" }] });
      const body = JSON.parse(raw || "{}") as { model?: string; messages?: { role: string; content: string }[] };
      calls.push({ path, auth: request.headers.authorization, body });
      if (path !== "/api/chat") return reply(404, { error: "404 page not found" });
      if (body.model === "missing") return reply(404, { error: "model 'missing' not found" });
      if (body.model === "cloud" && request.headers.authorization !== "Bearer ok-key") return reply(401, { error: "unauthorized" });
      if (body.model === "quiet") return reply(200, { model: body.model, message: { role: "assistant", content: "" }, done: true });
      return reply(200, { model: body.model, message: { role: "assistant", content: '{"cat": "Miso"}' }, done: true, done_reason: "stop" });
    });
  });
  return { calls, server };
}

describe("Ollama", () => {
  const fake = fakeOllama();
  let base = "";
  before(() => new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve)));
  before(() => {
    base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => fake.server.close(() => resolve())));
  const assistant = (fields: Record<string, unknown>) => Assistant.parse({ id: "local", connector: "ollama", url: base, ...fields });

  it("asks through Ollama's own chat API, one answer rather than a stream, with the memory as a system note", async () => {
    const answer = await ollama().send({ assistant: assistant({ model: "qwen3" }), ask: "What's my cat called?", memory: [note] });
    assert.deepEqual(answer, { text: '{"cat": "Miso"}', data: { cat: "Miso" } });
    const sent = fake.calls.at(-1)!;
    assert.equal(sent.path, "/api/chat");
    assert.equal(sent.auth, undefined, "no key for a local Ollama");
    assert.deepEqual(sent.body, {
      model: "qwen3",
      stream: false,
      messages: [
        { role: "system", content: "What you may use about the person:\n- (home) My cat is called Miso." },
        { role: "user", content: "What's my cat called?" },
      ],
    });
  });

  it("takes the address with /api or /v1 pasted on the end", async () => {
    await ollama().send({ assistant: assistant({ url: `${base}/v1/`, model: "qwen3" }), ask: "hi", memory: [] });
    assert.equal(fake.calls.at(-1)?.path, "/api/chat");
  });

  it("says what to do when the model isn't pulled, a key is wrong, the answer is empty, or no model is named", async () => {
    await assert.rejects(ollama().send({ assistant: assistant({ model: "missing" }), ask: "hi", memory: [] }), /local said: model 'missing' not found\. Pull it first: ollama pull missing/);
    process.env.TEST_OLLAMA_KEY = "bad-key";
    await assert.rejects(ollama().send({ assistant: assistant({ model: "cloud", keyEnv: "TEST_OLLAMA_KEY" }), ask: "hi", memory: [] }), /local said: unauthorized\. Check the key in TEST_OLLAMA_KEY\./);
    process.env.TEST_OLLAMA_KEY = "ok-key";
    assert.equal((await ollama().send({ assistant: assistant({ model: "cloud", keyEnv: "TEST_OLLAMA_KEY" }), ask: "hi", memory: [] })).text, '{"cat": "Miso"}');
    delete process.env.TEST_OLLAMA_KEY;
    await assert.rejects(ollama().send({ assistant: assistant({ model: "quiet" }), ask: "hi", memory: [] }), /local \(quiet\) answered without any text/);
    await assert.rejects(ollama().send({ assistant: assistant({}), ask: "hi", memory: [] }), /needs a model: one of the names `ollama list` shows/);
  });

  it("says Ollama isn't running when nothing answers", async () => {
    const closed = Assistant.parse({ id: "local", connector: "ollama", url: "http://127.0.0.1:9", model: "qwen3" });
    await assert.rejects(ollama().send({ assistant: closed, ask: "hi", memory: [] }), /Can't reach Ollama at http:\/\/127\.0\.0\.1:9\. Is it running\?/);
    await assert.rejects(ollamaModels("http://127.0.0.1:9"), /Can't reach Ollama/);
  });

  it("lists the models it has, for picking one", async () => {
    assert.deepEqual(await ollamaModels(`${base}/api`), ["gemma3:270m", "qwen3:latest"]);
  });
});
