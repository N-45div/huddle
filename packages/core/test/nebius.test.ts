import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nebius } from "../src/connectors/nebius.ts";
import { priceOf } from "../src/cost.ts";
import { modelJudge } from "../src/judge.ts";
import { modelPresenter } from "../src/present.ts";
import { Assistant, assistantProblems } from "../src/schema.ts";
import { currentModel, NEMOTRON, refreshTokenFactoryPrices, RETIRED, thinkingFor, TOKEN_FACTORY_URL, tokenFactoryModels, tokenFactoryPrice } from "../src/tokenfactory.ts";

const assistant = (fields: Record<string, unknown>) => Assistant.parse({ id: "nemo", connector: "nebius", ...fields });

describe("NVIDIA Nemotron on Nebius Token Factory", () => {
  it("asks Token Factory with NEBIUS_API_KEY, thinking off unless it's turned on", async () => {
    process.env.NEBIUS_API_KEY = "tf-secret";
    const asked: { url: string; auth: string | undefined; body: Record<string, unknown> }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      asked.push({ url, auth: (init.headers as Record<string, string>).authorization, body: JSON.parse(String(init.body)) });
      return Response.json({ choices: [{ message: { content: "Book the 7:40 train." } }], usage: { prompt_tokens: 30, completion_tokens: 8 } });
    }) as typeof fetch;
    const reply = await nebius(fetcher).send({ assistant: assistant({ model: NEMOTRON.super, maxTokens: 300 }), ask: "how do I get to Pune?", memory: [] });
    assert.deepEqual([reply.text, reply.usage], ["Book the 7:40 train.", { inputTokens: 30, outputTokens: 8 }]);
    assert.deepEqual([asked[0]?.url, asked[0]?.auth], [`${TOKEN_FACTORY_URL}/chat/completions`, "Bearer tf-secret"]);
    assert.deepEqual([asked[0]?.body.model, asked[0]?.body.max_tokens, asked[0]?.body.chat_template_kwargs], [NEMOTRON.super, 300, { enable_thinking: false }]);
    await nebius(fetcher).send({ assistant: assistant({ model: NEMOTRON.ultra, thinking: true }), ask: "plan my week", memory: [] });
    assert.deepEqual(asked[1]?.body.chat_template_kwargs, { enable_thinking: true });
    delete process.env.NEBIUS_API_KEY;
    await assert.rejects(nebius(fetcher).send({ assistant: assistant({ model: NEMOTRON.lightning }), ask: "hi", memory: [] }), /needs its key in the NEBIUS_API_KEY environment variable/);
  });

  it("asks the replacement of a model Token Factory retired, so flows saved with one keep working", async () => {
    process.env.NEBIUS_API_KEY = "tf-secret";
    const models: unknown[] = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      models.push(JSON.parse(String(init.body)).model);
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    }) as typeof fetch;
    await nebius(fetcher).send({ assistant: assistant({ model: "nvidia/nemotron-3-super-120b-a12b" }), ask: "hi", memory: [] });
    await nebius(fetcher).send({ assistant: assistant({ model: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B" }), ask: "hi", memory: [] });
    await nebius(fetcher).send({ assistant: assistant({ model: NEMOTRON.ultra }), ask: "hi", memory: [] });
    assert.deepEqual(models, ["nvidia/Nemotron-3.5-Super-VL", "nvidia/Nemotron-3_5-Lightning", NEMOTRON.ultra]);
    // Through the generic connector too, on Token Factory; another API's model of the same name is left alone.
    const { openai } = await import("../src/connectors/openai.ts");
    const generic = (url: string) => Assistant.parse({ id: "g", connector: "openai", url, model: "nvidia/nemotron-3-super-120b-a12b" });
    await openai(fetcher).send({ assistant: generic(TOKEN_FACTORY_URL), ask: "hi", memory: [] });
    await openai(fetcher).send({ assistant: generic("https://api.example.com/v1"), ask: "hi", memory: [] });
    assert.deepEqual(models.slice(3), ["nvidia/Nemotron-3.5-Super-VL", "nvidia/nemotron-3-super-120b-a12b"]);
    // Priced as what it now asks.
    assert.deepEqual(priceOf(assistant({ model: "nvidia/nemotron-3-super-120b-a12b" })), priceOf(assistant({ model: NEMOTRON.super })));
    assert.equal(currentModel(NEMOTRON.lightning), NEMOTRON.lightning);
    assert.ok(Object.values(RETIRED).every((model) => !(model in RETIRED)), "a replacement is never itself retired");
    delete process.env.NEBIUS_API_KEY;
  });

  it("needs a model, and is priced at Token Factory's listed price", async () => {
    assert.match(assistantProblems(assistant({})).join(" "), /a model on Nebius Token Factory: say which one/);
    await assert.rejects(nebius().send({ assistant: assistant({}), ask: "hi", memory: [] }), /needs a Token Factory model/);
    assert.deepEqual(priceOf(assistant({ model: NEMOTRON.ultra })), { input: 1, output: 3, call: 0 });
    // The same model reached through the generic OpenAI-style connector is priced too; another API isn't.
    const generic = (url: string) => Assistant.parse({ id: "g", connector: "openai", url, model: NEMOTRON.lightning });
    assert.deepEqual(priceOf(generic(TOKEN_FACTORY_URL)), { input: 0.06, output: 0.24, call: 0 });
    assert.equal(priceOf(generic("https://api.example.com/v1")), null);
    assert.deepEqual(thinkingFor(TOKEN_FACTORY_URL, false), { chat_template_kwargs: { enable_thinking: false } });
    assert.deepEqual(thinkingFor("https://api.openai.com/v1", false), {}, "other APIs don't know the switch");
  });

  it("turns thinking off for Huddle's own quick calls on Token Factory, and leaves other APIs alone", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ choices: [{ message: { content: '{"ranking": ["planner"], "view": "calculator"}' } }] });
    }) as typeof fetch;
    const candidates = [{ id: "quick", description: "fast everyday answers" }, { id: "planner", description: "multi-step plans" }];
    assert.deepEqual((await modelJudge({ url: TOKEN_FACTORY_URL, model: NEMOTRON.lightning, fetcher }).rank("plan a trip", candidates)).order, ["planner", "quick"]);
    await modelJudge({ url: "https://api.openai.com/v1", model: "gpt-5.4-mini", fetcher }).rank("plan a trip", candidates);
    await modelPresenter({ url: TOKEN_FACTORY_URL, model: NEMOTRON.lightning, fetcher }).choose({ text: "Split 120 four ways with a 15% tip." });
    assert.deepEqual(bodies.map((body) => body.chat_template_kwargs), [{ enable_thinking: false }, undefined, { enable_thinking: false }]);
  });

  it("reads current prices from the public catalog, and lists a key's models with NVIDIA's first", async () => {
    const catalog = (async () =>
      Response.json([
        { vendor: "nvidia", flavors: [{ model_id: NEMOTRON.super, input_price_per_million_tokens: 0.25, output_price_per_million_tokens: 0.8 }] },
        { vendor: "someone", flavors: [{ model_id: "acme/new-model", input_price_per_million_tokens: 0.1, output_price_per_million_tokens: "free" }] },
      ])) as unknown as typeof fetch;
    assert.equal(await refreshTokenFactoryPrices(catalog), 1);
    assert.deepEqual(tokenFactoryPrice(NEMOTRON.super), { input: 0.25, output: 0.8, call: 0 });
    assert.equal(tokenFactoryPrice("acme/new-model"), null, "a price that isn't a number is skipped");

    const listing = (async (url: string, init: RequestInit) => {
      assert.equal(url, `${TOKEN_FACTORY_URL}/models`);
      return (init.headers as Record<string, string>).authorization === "Bearer k" ? Response.json({ data: [{ id: "zai-org/GLM-5" }, { id: NEMOTRON.ultra }, { id: NEMOTRON.lightning }] }) : new Response("no", { status: 401 });
    }) as typeof fetch;
    assert.deepEqual(await tokenFactoryModels("k", listing), [NEMOTRON.lightning, NEMOTRON.ultra, "zai-org/GLM-5"]);
    await assert.rejects(tokenFactoryModels("wrong", listing), /didn't accept that key/);
    await assert.rejects(tokenFactoryModels(undefined, listing), /Set NEBIUS_API_KEY/);
  });
});
