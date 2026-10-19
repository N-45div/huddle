import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Meter, OwnLimit } from "../src/meter.ts";
import { Store } from "../src/store.ts";
import { NEMOTRON, TOKEN_FACTORY_URL } from "../src/tokenfactory.ts";

const ENDPOINT = `${TOKEN_FACTORY_URL}/chat/completions`;
const ask = (model: string) => ({ method: "POST", body: JSON.stringify({ model, messages: [] }) });

/** A model API that answers every call with this usage, and counts the calls. */
function api(usage = { prompt_tokens: 1_000, completion_tokens: 500 }) {
  const calls: string[] = [];
  const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
    calls.push(String(input));
    return Response.json({ choices: [{ message: { content: "{}" } }], usage });
  }) as typeof fetch;
  return { calls, fetcher };
}

const ownSpend = (store: Store) => store.spendSince("2000-01-01T00:00:00Z").filter((total) => total.assistant.startsWith("huddle: "));

describe("Huddle's own model calls", () => {
  it("counts each call in spend, priced where Huddle knows the model", async () => {
    const store = new Store();
    const { fetcher } = api();
    const meter = new Meter(store, { fetcher });
    const response = await meter.fetchFor("describe it")(ENDPOINT, ask(NEMOTRON.ultra));
    assert.deepEqual(await response.json(), { choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 1_000, completion_tokens: 500 } }, "the caller still reads the answer");
    await meter.fetchFor("views")("https://models.example/v1/chat/completions", ask("someone-elses-model"));
    const spent = ownSpend(store);
    const describeIt = spent.find((total) => total.assistant === "huddle: describe it");
    assert.ok(describeIt, JSON.stringify(spent));
    assert.equal(describeIt.usd, (1_000 * 1 + 500 * 3) / 1_000_000, "Ultra's price per million tokens");
    assert.equal(spent.find((total) => total.assistant === "huddle: views")?.usd ?? 0, 0, "an unknown price counts the call, not a guess");
  });

  it("leaves spend to the job when it records its own (fact checks, learning)", async () => {
    const store = new Store();
    const meter = new Meter(store, { fetcher: api().fetcher });
    await meter.fetchFor("learning", { record: false })(ENDPOINT, ask(NEMOTRON.super));
    assert.deepEqual(ownSpend(store), []);
    assert.equal(meter.callsLastMinute(), 1, "still counted against the minute");
  });

  it("holds calls to so many a minute, then lets them through again", async () => {
    let now = Date.parse("2026-10-21T10:00:00Z");
    const { calls, fetcher } = api();
    const meter = new Meter(new Store(), { fetcher, perMinute: 2, now: () => now });
    const judge = meter.fetchFor("auto judge");
    await judge(ENDPOINT, ask(NEMOTRON.lightning));
    await judge(ENDPOINT, ask(NEMOTRON.lightning));
    await assert.rejects(judge(ENDPOINT, ask(NEMOTRON.lightning)), (error: unknown) => error instanceof OwnLimit && /last minute/.test(error.message));
    assert.equal(calls.length, 2, "a refused call never goes out");
    now += 61_000;
    await judge(ENDPOINT, ask(NEMOTRON.lightning));
    assert.equal(calls.length, 3);
  });

  it("stops once the budget is spent, hand-offs and its own calls together", async () => {
    const store = new Store();
    const { calls, fetcher } = api();
    const meter = new Meter(store, { fetcher, budget: { usd: 0.01, period: "day" } });
    store.addOwnSpend("describe it", { inputTokens: 0, outputTokens: 0, costUsd: 0.006, estimated: false });
    await meter.fetchFor("tidy up")(ENDPOINT, ask(NEMOTRON.super));
    store.addOwnSpend("describe it", { inputTokens: 0, outputTokens: 0, costUsd: 0.006, estimated: false });
    await assert.rejects(meter.fetchFor("views")(ENDPOINT, ask(NEMOTRON.super)), (error: unknown) => error instanceof OwnLimit && /budget is spent/.test(error.message) && /views waits until tomorrow/.test(error.message));
    assert.equal(calls.length, 1);
  });
});
