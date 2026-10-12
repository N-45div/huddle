import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { vllm, vllmModels } from "../src/connectors/vllm.ts";
import { priceOf } from "../src/cost.ts";
import { Assistant, assistantProblems } from "../src/schema.ts";

const assistant = (fields: Record<string, unknown>) => Assistant.parse({ id: "mine", connector: "vllm", ...fields });

describe("models served by vLLM", () => {
  it("asks vLLM's chat API on this machine by default, or at the address given with or without /v1", async () => {
    const asked: { url: string; body: Record<string, unknown> }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      asked.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({ choices: [{ message: { content: "Hello from Qwen." } }], usage: { prompt_tokens: 12, completion_tokens: 5 } });
    }) as typeof fetch;
    const reply = await vllm(fetcher).send({ assistant: assistant({ model: "Qwen/Qwen3-8B", maxTokens: 200 }), ask: "hi", memory: [] });
    assert.deepEqual([reply.text, reply.usage], ["Hello from Qwen.", { inputTokens: 12, outputTokens: 5 }]);
    assert.equal(asked[0]?.url, "http://127.0.0.1:8000/v1/chat/completions");
    assert.deepEqual([asked[0]?.body.model, asked[0]?.body.max_tokens], ["Qwen/Qwen3-8B", 200]);
    await vllm(fetcher).send({ assistant: assistant({ model: "m", url: "https://gpu.example.com:8000/v1/" }), ask: "hi", memory: [] });
    assert.equal(asked[1]?.url, "https://gpu.example.com:8000/v1/chat/completions");
  });

  it("needs a model, says how to start vLLM when it isn't running, and is free on this machine", async () => {
    assert.match(assistantProblems(assistant({})).join(" "), /give the model's name as vLLM serves it/);
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await assert.rejects(vllm(down).send({ assistant: assistant({ model: "Qwen/Qwen3-8B" }), ask: "hi", memory: [] }), /can't reach vLLM at http:\/\/127\.0\.0\.1:8000\. Is it running\? Start it with: vllm serve Qwen\/Qwen3-8B/);
    assert.deepEqual(priceOf(assistant({ model: "m" })), { input: 0, output: 0, call: 0 });
    assert.equal(priceOf(assistant({ model: "m", url: "https://gpu.example.com" })), null, "someone else's GPU isn't free");
  });

  it("lists the models it serves, with the key when it was started with --api-key", async () => {
    let auth: string | null = null;
    const fetcher = (async (url: string, init: RequestInit) => {
      auth = (init.headers as Record<string, string>).authorization ?? null;
      assert.equal(url, "http://gpu.local:8000/v1/models");
      return auth ? Response.json({ data: [{ id: "meta-llama/Llama-3.3-70B" }, { id: "Qwen/Qwen3-8B" }] }) : Response.json({ error: "unauthorized" }, { status: 401 });
    }) as typeof fetch;
    await assert.rejects(vllmModels("http://gpu.local:8000", undefined, fetcher), /wants a key/);
    assert.deepEqual(await vllmModels("http://gpu.local:8000/v1", "secret", fetcher), ["Qwen/Qwen3-8B", "meta-llama/Llama-3.3-70B"]);
    assert.equal(auth, "Bearer secret");
  });
});
