import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tavily } from "../src/connectors/tavily.ts";
import { Engine } from "../src/engine.ts";
import { type FactCheck, factChecker, quoted } from "../src/factcheck.ts";
import { Assistant, parseFlow } from "../src/schema.ts";
import { Store } from "../src/store.ts";
import { NEMOTRON, TOKEN_FACTORY_URL } from "../src/tokenfactory.ts";

const TRAIN = "Tippu Express (12609) leaves KSR Bengaluru at 06:00 and reaches Mysuru at 08:30.";
const PALACE = "Mysuru Palace entry is ₹100 for adults.";

/** Token Factory for both models, Tavily for the searches: answers by what's asked. */
function world(judgeSays: unknown, failSearchFor?: string) {
  const searched: string[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { query?: string; messages?: { content: string }[]; chat_template_kwargs?: unknown };
    if (url.endsWith("/search")) {
      searched.push(body.query!);
      if (body.query === failSearchFor) return Response.json({ detail: { error: "boom" } }, { status: 500 });
      const content = body.query!.startsWith("Tippu")
        ? "Train 12609 Tippu Express departs KSR Bengaluru (SBC) at 06:00 and arrives Mysuru Junction at 08:30, daily."
        : "Mysore Palace tickets: Adults Rs. 120, children Rs. 70 (revised 2026).";
      return Response.json({ results: [{ title: "Timetable", url: `https://example.com/${searched.length}`, content, score: 0.9 }], usage: { credits: 2 } });
    }
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false }, "checks don't wait on thinking");
    const isJudge = body.messages![0]!.content.startsWith("You check facts");
    const content = isJudge ? JSON.stringify(judgeSays) : JSON.stringify({ facts: [TRAIN, PALACE] });
    return Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } });
  }) as typeof fetch;
  const check = factChecker({ tavilyKey: "tvly-k", lister: { url: TOKEN_FACTORY_URL, model: NEMOTRON.lightning, key: "tf" }, judge: { url: TOKEN_FACTORY_URL, model: NEMOTRON.super, key: "tf" }, fetcher });
  return { check, searched };
}

describe("checking the facts in an approval", () => {
  it("backs a fact only with a quote that's really in its source", async () => {
    const { check, searched } = world({
      verdicts: [
        { fact: 1, verdict: "supported", source: 1, quote: "departs KSR Bengaluru (SBC) at 06:00 and arrives Mysuru Junction at 08:30", note: "The timetable matches." },
        // The model says "contradicted" with a quote the source doesn't contain: not evidence.
        { fact: 2, verdict: "contradicted", source: 1, quote: "Adult entry is Rs. 200", note: "It's more." },
      ],
    });
    const result = await check(`Plan:\n${TRAIN}\n${PALACE}`);
    assert.deepEqual(searched, [TRAIN, PALACE]);
    assert.equal(result.facts[0]!.verdict, "supported");
    assert.equal(result.facts[0]!.source?.url, "https://example.com/1");
    assert.equal(result.facts[1]!.verdict, "unclear");
    assert.match(result.facts[1]!.note, /quote given as evidence isn't in the source/);
    // 4 credits of Tavily plus two Nemotron calls at their listed prices.
    const models = (1000 * 0.06 + 100 * 0.24 + 1000 * 0.3 + 100 * 0.9) / 1_000_000;
    assert.ok(Math.abs(result.costUsd - (4 * 0.008 + models)) < 1e-9, String(result.costUsd));
    assert.equal(result.checkedBy, `${NEMOTRON.super} with Tavily`);
  });

  it("leaves a fact unclear when its search fails, and quotes loosely but honestly", async () => {
    const { check } = world({ verdicts: [{ fact: 1, verdict: "supported", source: 1, quote: "departs KSR Bengaluru (SBC) at 06:00", note: "Matches." }] }, PALACE);
    const result = await check(TRAIN);
    assert.equal(result.facts[1]!.verdict, "unclear");
    assert.match(result.facts[1]!.note, /Couldn't search for it/);
    assert.ok(quoted("“Departs KSR   Bengaluru”", "Train departs KSR Bengaluru daily"), "case, spacing and curly quotes don't matter");
    assert.ok(!quoted("06:00", "at 06:00"), "too short to count as evidence");
  });

  it("checks before the person is asked, keeps the result with the approval, and counts its cost", async () => {
    const flow = parseFlow({ name: "Trip", assistants: [{ id: "a", connector: "mock", replies: { "*": TRAIN } }], steps: [{ id: "plan", type: "agent", agent: "a", ask: "plan" }, { id: "ok", type: "approval", message: "Book this? {{plan.text}}", check: true }] });
    const canned: FactCheck = { facts: [{ claim: TRAIN, verdict: "supported", note: "Matches.", source: { title: "Timetable", url: "https://example.com", quote: "departs at 06:00" } }], checkedBy: "m with Tavily", costUsd: 0.02 };
    const store = new Store();
    const engine = new Engine(store, { mock: (await import("../src/connectors/mock.ts")).mock }, { checker: async () => canned });
    const view = await engine.start(flow, "go");
    assert.equal(view.state, "waiting");
    assert.deepEqual(store.waitingApprovals()[0]!.checks, canned);
    assert.ok(store.logOf(view.id).some((line) => line.kind === "fact-checked"));
    assert.equal(engine.spent(), 0.02);

    // No checker set up, or one that fails: still asked, and the log says why it wasn't checked.
    for (const checker of [undefined, async () => Promise.reject(new Error("Tavily's credits for this key are used up for the month."))]) {
      const plain = new Store();
      const unchecked = await new Engine(plain, { mock: (await import("../src/connectors/mock.ts")).mock }, checker ? { checker } : {}).start(flow, "go");
      assert.equal(unchecked.state, "waiting");
      assert.equal(plain.waitingApprovals()[0]!.checks, null);
      assert.match(JSON.stringify(plain.logOf(unchecked.id).find((line) => line.kind === "unchecked")), checker ? /used up/ : /needs TAVILY_API_KEY/);
    }
  });
});

describe("web search with Tavily", () => {
  it("answers with Tavily's answer and its sources, priced by the credits it used", async () => {
    process.env.TAVILY_API_KEY = "tvly-k";
    let sent: Record<string, unknown> = {};
    const fetcher = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return Response.json({ answer: "It opens at 10:00.", results: [{ title: "Palace", url: "https://palace.example", content: "Open 10:00-17:30", score: 0.8 }], usage: { credits: 2 } });
    }) as typeof fetch;
    const reply = await tavily(fetcher).send({ assistant: Assistant.parse({ id: "web", connector: "tavily" }), ask: "When does Mysore Palace open?", memory: [] });
    assert.equal(reply.text, "It opens at 10:00.\n\nSources:\n1. Palace (https://palace.example)");
    assert.equal(reply.usage?.costUsd, 0.016);
    assert.deepEqual([sent.query, sent.search_depth, sent.include_answer], ["When does Mysore Palace open?", "advanced", true]);
    delete process.env.TAVILY_API_KEY;
    await assert.rejects(tavily(fetcher).send({ assistant: Assistant.parse({ id: "web", connector: "tavily" }), ask: "x", memory: [] }), /TAVILY_API_KEY/);
  });
});
