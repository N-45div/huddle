import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Connector } from "../src/connector.ts";
import { mock } from "../src/connectors/mock.ts";
import { ollama } from "../src/connectors/ollama.ts";
import { openai } from "../src/connectors/openai.ts";
import { costOf, parseBudget, periodStart, priceOf, spendOf } from "../src/cost.ts";
import { Engine } from "../src/engine.ts";
import type { Judge } from "../src/judge.ts";
import { NoAnswer, Router, STICKY_MS } from "../src/router.ts";
import { Assistant, parseFlow } from "../src/schema.ts";
import { Store } from "../src/store.ts";

const assistant = (fields: Record<string, unknown>) => Assistant.parse(fields);

describe("what a hand-off costs", () => {
  it("prices tokens per million, cached input at its own rate, plus a per-call fee", () => {
    const priced = assistant({ id: "claude", connector: "openai", url: "http://x.test", price: { input: 3, output: 15, cached: 0.3, call: 0.001 } });
    assert.equal(costOf(priced, { inputTokens: 1_000_000, outputTokens: 0 }), 3.001);
    assert.equal(costOf(priced, { inputTokens: 1_000, outputTokens: 1_000, cachedTokens: 800 }), (200 * 3 + 800 * 0.3 + 1_000 * 15) / 1_000_000 + 0.001);
    assert.equal(costOf(priced, { inputTokens: 10, outputTokens: 10, costUsd: 0.5 }), 0.5, "the provider's own figure wins");
  });

  it("counts stand-ins and Ollama on this machine as free, and anything else without a price as unknown", () => {
    assert.deepEqual(priceOf(assistant({ id: "m", connector: "mock" })), { input: 0, output: 0, call: 0 });
    assert.deepEqual(priceOf(assistant({ id: "o", connector: "ollama", model: "qwen3" })), { input: 0, output: 0, call: 0 });
    assert.equal(priceOf(assistant({ id: "c", connector: "ollama", model: "qwen3", url: "https://ollama.com" })), null);
    assert.equal(priceOf(assistant({ id: "h", connector: "hermes" })), null);
    assert.equal(costOf(assistant({ id: "h", connector: "hermes" }), { inputTokens: 100, outputTokens: 100 }), null);
  });

  it("guesses tokens from the text when the assistant doesn't count them, and says so", () => {
    const spend = spendOf(assistant({ id: "m", connector: "mock" }), undefined, "x".repeat(400), "y".repeat(40));
    assert.deepEqual(spend, { inputTokens: 100, outputTokens: 10, costUsd: 0, estimated: true });
  });

  it("reads OpenAI's usage, OpenRouter's cost and cached tokens, and caps the answer's length", async () => {
    let sent: Record<string, unknown> = {};
    const fetcher = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return Response.json({ choices: [{ message: { content: "Hi." } }], usage: { prompt_tokens: 1200, completion_tokens: 30, cost: 0.00042, prompt_tokens_details: { cached_tokens: 1024 } } });
    }) as typeof fetch;
    const reply = await openai(fetcher).send({ assistant: assistant({ id: "r", connector: "openai", url: "https://openrouter.ai/api", maxTokens: 300 }), ask: "hi", memory: [] });
    assert.deepEqual(reply.usage, { inputTokens: 1200, outputTokens: 30, cachedTokens: 1024, costUsd: 0.00042 });
    assert.equal(sent.max_tokens, 300);
  });

  it("reads Ollama's own token counts", async () => {
    let sent: Record<string, unknown> = {};
    const fetcher = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return Response.json({ message: { content: "Hello." }, prompt_eval_count: 42, eval_count: 7 });
    }) as typeof fetch;
    const reply = await ollama(fetcher).send({ assistant: assistant({ id: "o", connector: "ollama", model: "qwen3", maxTokens: 64 }), ask: "hi", memory: [] });
    assert.deepEqual(reply.usage, { inputTokens: 42, outputTokens: 7 });
    assert.deepEqual(sent.options, { num_predict: 64 });
  });

  it("says when a capped answer ran out of tokens before it got to the answer, as thinking models can", async () => {
    const thinking = (async () => Response.json({ message: { content: "", thinking: "Okay, the user asked me to" }, done_reason: "length", prompt_eval_count: 20, eval_count: 40 })) as unknown as typeof fetch;
    await assert.rejects(ollama(thinking).send({ assistant: assistant({ id: "qwen", connector: "ollama", model: "qwen3:0.6b", maxTokens: 40 }), ask: "hi", memory: [] }), /qwen \(qwen3:0\.6b\) ran out of tokens before it answered \(its cap is 40, all of it thinking\)\. Raise its longest answer/);
    const capped = (async () => Response.json({ choices: [{ message: { content: "" }, finish_reason: "length" }] })) as unknown as typeof fetch;
    await assert.rejects(openai(capped).send({ assistant: assistant({ id: "o1", connector: "openai", url: "http://x.test", maxTokens: 50 }), ask: "hi", memory: [] }), /o1 ran out of tokens before it answered \(its cap is 50/);
  });

  it('reads a budget as "20/month", "5/day" or a bare number of dollars a month', () => {
    assert.deepEqual(parseBudget("20/month"), { usd: 20, period: "month" });
    assert.deepEqual(parseBudget("$5 / day"), { usd: 5, period: "day" });
    assert.deepEqual(parseBudget("12.5"), { usd: 12.5, period: "month" });
    assert.equal(parseBudget(""), null);
    assert.throws(() => parseBudget("lots"), /HUDDLE_BUDGET should look like "20\/month"/);
    assert.equal(periodStart("month", new Date("2026-10-11T09:30:00Z")).toISOString(), "2026-10-01T00:00:00.000Z");
    assert.equal(periodStart("day", new Date("2026-10-11T09:30:00Z")).toISOString(), "2026-10-11T00:00:00.000Z");
  });
});

/** A connector that answers with the tokens it's told to report. */
const counted = (tokens: { inputTokens: number; outputTokens: number }): Connector => ({ send: async ({ assistant: one }) => ({ text: `${one.id} answered.`, usage: tokens }) });

describe("the engine's spending", () => {
  const flow = parseFlow({ name: "Ask", assistants: [{ id: "paid", connector: "openai", url: "http://paid.test", price: { input: 2, output: 10 } }, { id: "free", connector: "mock", replies: { "*": "Free answer." } }], steps: [{ id: "a", type: "agent", agent: "paid", ask: "{{input}}" }, { id: "b", type: "agent", agent: "free", ask: "{{input}}" }] });

  it("logs and keeps what each hand-off took", async () => {
    const store = new Store();
    const view = await new Engine(store, { mock, openai: counted({ inputTokens: 1_000, outputTokens: 500 }) }).start(flow, "hi");
    const answered = store.logOf(view.id).filter((line) => line.kind === "answered").map((line) => (line.detail as { cost: unknown }).cost);
    assert.deepEqual(answered[0], { inputTokens: 1_000, outputTokens: 500, costUsd: 0.007, estimated: false });
    assert.equal((answered[1] as { estimated: boolean }).estimated, true);
    const totals = store.spendSince("2000-01-01");
    assert.deepEqual(totals.map((total) => [total.assistant, total.calls, total.usd]), [["paid", 1, 0.007], ["free", 1, 0]]);
    assert.equal(view.context.steps.a?.text, "paid answered.", "the run's context stays the answer alone");
  });

  it("stops paid assistants once the budget is spent, and lets free ones carry on", async () => {
    const store = new Store();
    const engine = new Engine(store, { mock, openai: counted({ inputTokens: 1_000_000, outputTokens: 0 }) }, { budget: { usd: 3, period: "month" } });
    const first = await engine.start(flow, "hi");
    assert.equal(first.state, "done");
    assert.equal(engine.spent(), 2);
    const second = await engine.start(flow, "hi");
    assert.equal(second.state, "done", "$2 of $3: still under");
    const third = await engine.start(flow, "hi");
    assert.equal(third.state, "failed");
    assert.match(third.error ?? "", /This month's budget is spent \(\$4\.00 of \$3\.00\), so "paid", which costs money, wasn't asked/);
    const freeOnly = parseFlow({ ...flow, steps: [{ id: "b", type: "agent", agent: "free", ask: "{{input}}" }] });
    assert.equal((await engine.start(freeOnly, "hi")).state, "done");
  });
});

describe("the router's costs", () => {
  /** Three assistants; the judge always says the same. */
  function setup(probabilities: Record<string, number>, options: { budget?: { usd: number; period: "day" | "month" }; extra?: Record<string, unknown>[] } = {}) {
    const store = new Store();
    store.saveAssistants([
      assistant({ id: "pricey", connector: "openai", url: "http://pricey.test", description: "Careful, expensive.", price: { input: 15, output: 75 } }),
      assistant({ id: "cheap", connector: "openai", url: "http://cheap.test", description: "Quick and cheap.", price: { input: 0.1, output: 0.5 } }),
      assistant({ id: "local", connector: "mock", description: "On this machine.", replies: { "*": "Local here." } }),
      ...(options.extra ?? []).map(assistant),
    ]);
    const engine = new Engine(store, { mock, openai: counted({ inputTokens: 300, outputTokens: 200 }), http: { send: async () => ({ text: "Unknown here." }) } }, options.budget ? { budget: options.budget } : {});
    let judged = 0;
    const order = Object.keys(probabilities).sort((a, b) => probabilities[b]! - probabilities[a]!);
    const judge: Judge = { name: "jev", rank: async () => (judged++, { judge: "jev", order, probabilities, confidence: 0.8, model: "jev-test" }) };
    let clock = 1_000_000;
    const router = new Router(store, engine, judge, () => clock);
    return { store, engine, router, judged: () => judged, tick: (ms: number) => (clock += ms) };
  }

  it("of the assistants that fit nearly as well as the best, asks the cheapest first, and records what that saved", async () => {
    const { router, store } = setup({ pricey: 0.5, cheap: 0.4, local: 0.1 });
    const routed = await router.answer({ model: "auto", ask: "Summarise this" });
    assert.equal(routed.assistant.id, "cheap", "0.4 is within 60% of 0.5; local's 0.1 isn't");
    assert.deepEqual(routed.route?.order, ["cheap", "pricey", "local"]);
    assert.equal(routed.route?.cost?.top, "pricey");
    assert.equal(routed.route?.cost?.reordered, true);
    assert.ok((routed.route?.cost?.estimates.pricey ?? 0) > (routed.route?.cost?.estimates.cheap ?? 1));
    const saved = store.spendSince("2000-01-01", true).find((total) => total.assistant === "cheap");
    assert.equal(saved?.cheaper, 1);
    assert.ok((saved?.savedByCheaper ?? 0) > 0);
    assert.ok(store.logOf(routed.runId).some((line) => line.kind === "routed"), "how it was routed is in the run's log");
  });

  it('keeps the judge\'s order for prefer "quality", and reaches further for "cheapest"', async () => {
    assert.equal((await setup({ pricey: 0.5, cheap: 0.4, local: 0.15 }).router.answer({ model: "auto", ask: "x", prefer: "quality" })).assistant.id, "pricey");
    const cheapest = await setup({ pricey: 0.5, cheap: 0.4, local: 0.15 }).router.answer({ model: "auto", ask: "x", prefer: "cheapest" });
    assert.equal(cheapest.assistant.id, "local", "0.15 is within 25% of 0.5, and it's free");
  });

  it("puts a free assistant before one whose cost is unknown, and doesn't reorder when nothing's cost is known", async () => {
    const extra = [{ id: "mystery", connector: "http", url: "http://mystery.test", description: "Who knows." }];
    const { router } = setup({ mystery: 0.5, local: 0.45, pricey: 0.05 }, { extra });
    assert.equal((await router.answer({ model: "auto", ask: "x", models: ["mystery", "local", "pricey"] })).assistant.id, "local");
    const unknownOnly = setup({ mystery: 0.5, other: 0.45 }, { extra: [...extra, { id: "other", connector: "http", url: "http://other.test" }] });
    const routed = await unknownOnly.router.answer({ model: "auto", ask: "x", models: ["mystery", "other"] });
    assert.equal(routed.assistant.id, "mystery");
    assert.equal(routed.route?.cost?.reordered, false);
  });

  it("keeps a conversation with the same assistant for ten minutes, without asking the judge again", async () => {
    const { router, judged, tick } = setup({ pricey: 0.5, cheap: 0.4, local: 0.1 });
    const first = await router.answer({ model: "auto", ask: "Plan a trip", conversation: "c1" });
    assert.equal(first.assistant.id, "cheap");
    const again = await router.answer({ model: "auto", ask: "Plan a trip", conversation: "c1", prefer: "quality" });
    assert.equal(judged(), 2, "the same first message again is a new conversation, judged afresh");
    assert.equal(again.assistant.id, "pricey");
    const second = await router.answer({ model: "auto", ask: "Plan a trip\n\nNow: make it shorter", conversation: "c1", followUp: true });
    assert.equal(second.assistant.id, "pricey", "a later turn goes where the last one went");
    assert.equal(second.route?.judge, "sticky");
    assert.equal(judged(), 2);
    await router.answer({ model: "auto", ask: "Something else", conversation: "c2", followUp: true });
    assert.equal(judged(), 3, "another conversation is judged");
    tick(STICKY_MS + 1);
    await router.answer({ model: "auto", ask: "Back again", conversation: "c1", followUp: true });
    assert.equal(judged(), 4, "ten quiet minutes later, judged afresh");
  });

  it("answers the very same ask again from a kept answer, only for assistants that allow it, until memory changes", async () => {
    const { router, store } = setup({ cheap: 1 }, { extra: [{ id: "facts", connector: "openai", url: "http://facts.test", memory: ["home"], price: { input: 1, output: 1 }, reuseMinutes: 60 }] });
    const first = await router.answer({ model: "facts", ask: "What's  my cat called?" });
    const again = await router.answer({ model: "facts", ask: "What's my cat called? " });
    assert.equal(again.reused, true, "the same ask, give or take spaces");
    assert.equal(again.runId, first.runId);
    assert.equal(again.text, first.text);
    assert.equal(store.runs(50).length, 1, "no new run");
    const totals = store.spendSince("2000-01-01", true).find((total) => total.assistant === "facts");
    assert.deepEqual([totals?.calls, totals?.reused, totals?.savedByReuse], [1, 1, first.cost?.costUsd]);
    assert.equal((await router.answer({ model: "facts", ask: "What's my cat called?", reuse: false })).reused, false, "asked afresh when told to");
    store.remember("home", "The cat is called Miso.");
    assert.equal((await router.answer({ model: "facts", ask: "What's my cat called?" })).reused, false, "memory changed: asked afresh");
    assert.equal((await router.answer({ model: "cheap", ask: "hi" })).reused, false);
    assert.equal((await router.answer({ model: "cheap", ask: "hi" })).reused, false, "cheap doesn't allow reuse");
  });

  it("goes for the cheapest past 80% of the budget, and skips paid assistants once it's spent", async () => {
    const { router, store, engine } = setup({ pricey: 0.5, cheap: 0.45, local: 0.2 }, { budget: { usd: 1, period: "month" } });
    const earlier = parseFlow({ name: "Earlier", assistants: [{ id: "x", connector: "mock" }], steps: [{ id: "s", type: "agent", agent: "x", ask: "x" }] });
    store.addSpend({ id: "run_old", flowId: null, flow: earlier }, "s", "pricey", { inputTokens: 0, outputTokens: 0, costUsd: 0.85, estimated: false });
    const pressed = await router.answer({ model: "auto", ask: "x" });
    assert.equal(pressed.assistant.id, "local");
    assert.match(pressed.route?.note ?? "", /\$0\.85 of this month's \$1\.00 is spent, so the cheapest that fits/);
    store.addSpend({ id: "run_old2", flowId: null, flow: earlier }, "s", "pricey", { inputTokens: 0, outputTokens: 0, costUsd: 0.2, estimated: false });
    assert.ok(engine.spent() >= 1);
    await assert.rejects(router.answer({ model: "pricey", ask: "x" }), (error: NoAnswer) => {
      assert.equal(error.tried[0]?.overBudget, true);
      assert.match(error.message, /The budget \(\$1\.00 a month\) is spent, and "pricey" costs money/);
      return true;
    });
    assert.equal((await router.answer({ model: "pricey", models: ["local"], ask: "x" })).assistant.id, "local", "a free fallback still answers");
  });
});
