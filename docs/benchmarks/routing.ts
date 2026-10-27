/**
 * Does letting Nemotron pick the size pay? 24 everyday asks (8 quick, 8 to write, 8 to plan) go two ways
 * through a real Huddle router on Nebius Token Factory:
 *
 *   auto      Nemotron 3.5 Lightning judges which of three assistants fits: Lightning (quick answers),
 *             Super (writing) or Ultra with thinking (plans). The judge's own call is counted in its cost.
 *   best      every ask to the best assistant, Ultra with thinking: "just use the biggest model".
 *
 * Nemotron Super then grades each pair blind (the two answers in a random order, which one is which hidden).
 * For writing, auto's answer is Super's own, so that verdict is self-graded. Costs are Token Factory's listed
 * prices on the tokens each call reports.
 *
 *   NEBIUS_API_KEY=... node --no-warnings docs/benchmarks/routing.ts
 *
 * Writes docs/benchmarks/routing-results.json and prints the summary that docs/benchmarks/routing.md quotes.
 */
import { writeFileSync } from "node:fs";
import { Assistants, defaultConnectors, Engine, modelJudge, NEMOTRON, refreshTokenFactoryPrices, Router, Store, thinkingFor, TOKEN_FACTORY_URL, tokenFactoryPrice } from "../../packages/core/src/index.ts";

const key = process.env.NEBIUS_API_KEY?.trim();
if (!key) throw new Error("Set NEBIUS_API_KEY.");

const ASKS: readonly { readonly kind: "quick" | "write" | "plan"; readonly ask: string }[] = [
  { kind: "quick", ask: "What's 18% of 2,400?" },
  { kind: "quick", ask: "Convert 72°F to Celsius." },
  { kind: "quick", ask: "How many days are there from 17 October 2026 to 25 December 2026?" },
  { kind: "quick", ask: "Is 2027 a leap year?" },
  { kind: "quick", ask: "What's the capital of Australia?" },
  { kind: "quick", ask: "Split ₹3,450 equally between 3 people." },
  { kind: "quick", ask: "What does RSVP stand for?" },
  { kind: "quick", ask: "How many minutes are there in 3.5 hours?" },
  { kind: "write", ask: "Write a two-line message to my landlord saying the rent will be two days late this month." },
  { kind: "write", ask: "Draft a polite email declining a meeting on Friday and offering Monday morning instead." },
  { kind: "write", ask: "Write a short birthday message for my colleague Priya." },
  { kind: "write", ask: "Reply to a recruiter: I'm interested, but only in fully remote roles." },
  { kind: "write", ask: "Write a WhatsApp message asking my plumber to come on Saturday morning to fix a leaking tap." },
  { kind: "write", ask: "Write a thank-you note to a friend who helped me move house last weekend." },
  { kind: "write", ask: "Ask my manager for next Monday off, briefly." },
  { kind: "write", ask: "Write a LinkedIn comment congratulating a friend on her new job as a product manager." },
  { kind: "plan", ask: "Plan a 3-day trip from Bengaluru to Goa for two under ₹20,000, day by day." },
  { kind: "plan", ask: "Make a weekly grocery plan for two vegetarians under ₹2,500." },
  { kind: "plan", ask: "I earn ₹60,000 a month and have ₹50,000 saved. Plan an emergency fund and a monthly saving schedule." },
  { kind: "plan", ask: "Plan my week: the gym three times, a 10-hour work project, and calling my parents twice." },
  { kind: "plan", ask: "Should I buy or lease a car if I drive 8,000 km a year? Lay out the trade-offs and recommend one." },
  { kind: "plan", ask: "Plan a 6-week programme to get a beginner running 5 km without stopping." },
  { kind: "plan", ask: "Organise a birthday dinner for 8 people under ₹10,000: venue type, menu, timeline." },
  { kind: "plan", ask: "Plan how to finish a 40-hour online course in 4 weeks around a full-time job." },
];
const EXPECTED = { quick: "quick", write: "writer", plan: "planner" } as const;

await refreshTokenFactoryPrices().catch(() => undefined);
process.env.BENCH_NEBIUS_KEY = key;
const team = Assistants.parse([
  { id: "quick", name: "Quick answers (Lightning)", connector: "nebius", model: NEMOTRON.lightning, keyEnv: "BENCH_NEBIUS_KEY", description: "Quick everyday answers: facts, sums, conversions, a word or a sentence.", maxTokens: 400 },
  { id: "writer", name: "Writer (Super)", connector: "nebius", model: NEMOTRON.super, keyEnv: "BENCH_NEBIUS_KEY", description: "Writes emails, messages and posts in the person's voice.", maxTokens: 800 },
  { id: "planner", name: "Planner (Ultra, thinking)", connector: "nebius", model: NEMOTRON.ultra, thinking: true, keyEnv: "BENCH_NEBIUS_KEY", description: "Plans with several steps or trade-offs: trips, budgets, schedules, decisions.", maxTokens: 4000 },
]);

// The judge's own calls are counted: its fetch is watched for the tokens Token Factory reports.
let judgeUsd = 0;
const watched = (async (input: string | URL | Request, init?: RequestInit) => {
  const response = await fetch(input, init);
  const body = (await response.clone().json().catch(() => null)) as { usage?: { prompt_tokens?: number; completion_tokens?: number } } | null;
  const price = tokenFactoryPrice(NEMOTRON.lightning)!;
  judgeUsd += ((body?.usage?.prompt_tokens ?? 0) * price.input + (body?.usage?.completion_tokens ?? 0) * price.output) / 1_000_000;
  return response;
}) as typeof fetch;

const store = new Store();
store.saveAssistants(team);
const router = new Router(store, new Engine(store, defaultConnectors()), modelJudge({ url: TOKEN_FACTORY_URL, model: NEMOTRON.lightning, key, fetcher: watched }));

/** Super grades one pair blind; the order is shuffled by a seeded coin so a rerun grades the same way. */
async function grade(ask: string, auto: string, best: string, flip: boolean): Promise<"auto" | "best" | "tie"> {
  const [a, b] = flip ? [best, auto] : [auto, best];
  const response = await fetch(`${TOKEN_FACTORY_URL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: NEMOTRON.super,
      temperature: 0,
      ...thinkingFor(TOKEN_FACTORY_URL, false),
      messages: [
        { role: "system", content: 'You compare two answers to a person\'s request. Judge which serves the person better: correct, complete for what was asked, and as short as the request wants (a quick question wants a quick answer). If they\'re about as good, say tie. Answer with JSON only: {"winner": "A" | "B" | "tie", "why": "<one line>"}' },
        { role: "user", content: `Request: ${ask}\n\nAnswer A:\n${a}\n\nAnswer B:\n${b}` },
      ],
    }),
  });
  const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const winner = (JSON.parse(/\{[\s\S]*\}/.exec(body.choices?.[0]?.message?.content ?? "")?.[0] ?? "{}") as { winner?: string }).winner;
  if (winner === "tie" || (winner !== "A" && winner !== "B")) return "tie";
  return (winner === "A") !== flip ? "auto" : "best";
}

const rows = [];
for (const [index, { kind, ask }] of ASKS.entries()) {
  const before = judgeUsd;
  let started = performance.now();
  const auto = await router.answer({ model: "auto", ask, reuse: false });
  const autoMs = performance.now() - started;
  started = performance.now();
  const best = await router.answer({ model: "planner", ask, reuse: false });
  const bestMs = performance.now() - started;
  const verdict = await grade(ask, auto.text, best.text, index % 2 === 1);
  const row = {
    kind,
    ask,
    routedTo: auto.assistant.id,
    expected: EXPECTED[kind],
    autoUsd: (auto.cost?.costUsd ?? 0) + (judgeUsd - before),
    bestUsd: best.cost?.costUsd ?? 0,
    autoMs: Math.round(autoMs),
    bestMs: Math.round(bestMs),
    verdict,
  };
  rows.push(row);
  console.log(`${String(index + 1).padStart(2)} ${kind.padEnd(5)} -> ${row.routedTo.padEnd(7)} auto $${row.autoUsd.toFixed(5)} ${String(row.autoMs).padStart(6)} ms | best $${row.bestUsd.toFixed(5)} ${String(row.bestMs).padStart(6)} ms | ${verdict}`);
}

const sum = (pick: (row: (typeof rows)[number]) => number) => rows.reduce((total, row) => total + pick(row), 0);
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const summary = {
  date: new Date().toISOString().slice(0, 10),
  asks: rows.length,
  routedAsExpected: rows.filter((row) => row.routedTo === row.expected).length,
  autoUsd: sum((row) => row.autoUsd),
  bestUsd: sum((row) => row.bestUsd),
  autoMedianMs: median(rows.map((row) => row.autoMs)),
  bestMedianMs: median(rows.map((row) => row.bestMs)),
  verdicts: { auto: rows.filter((row) => row.verdict === "auto").length, tie: rows.filter((row) => row.verdict === "tie").length, best: rows.filter((row) => row.verdict === "best").length },
};
writeFileSync(new URL("./routing-results.json", import.meta.url), `${JSON.stringify({ summary, rows }, null, 2)}\n`);
console.log(`\n${JSON.stringify(summary, null, 2)}`);
console.log(`auto cost ${((1 - summary.autoUsd / summary.bestUsd) * 100).toFixed(0)}% less than always-Ultra; graded better or tied on ${summary.verdicts.auto + summary.verdicts.tie} of ${summary.asks}`);
