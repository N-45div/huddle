import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { monid, monidInput } from "../src/connectors/monid.ts";
import { blockedReason, estimateUsd, inputFields, monidClient, parseTool, priceText, starterInput, toolId } from "../src/monid.ts";
import { Assistant, assistantProblems } from "../src/schema.ts";

const KEY = "mk_test_secret_key";

interface Call {
  readonly path: string;
  readonly body: unknown;
  readonly auth: string | undefined;
}

/** A stand-in Monid: tools by id, and the run states a run goes through, one per lookup. */
function fakeMonid(options: {
  readonly tools?: Readonly<Record<string, unknown>>;
  readonly states?: readonly unknown[];
  readonly found?: readonly unknown[];
}) {
  const calls: Call[] = [];
  let looked = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body, auth: (init?.headers as Record<string, string> | undefined)?.authorization });
    if (path === "/v1/inspect") {
      const tool = options.tools?.[`${body.provider}${body.endpoint}`];
      return tool ? Response.json(tool) : Response.json({ error: "not found" }, { status: 404 });
    }
    if (path === "/v1/discover") return Response.json({ results: options.found ?? [] });
    if (path === "/v1/run") return Response.json(options.states?.[0] ?? {});
    if (path.startsWith("/v1/runs/")) {
      looked += 1;
      return Response.json(options.states?.[Math.min(looked, (options.states?.length ?? 1) - 1)] ?? {});
    }
    return Response.json({ error: "no such path" }, { status: 404 });
  }) as typeof fetch;
  return { fetcher, calls };
}

const JOBS = {
  description: "Google Jobs search results for a keyword and location.",
  tags: ["jobs", "serp"],
  price: { type: "PER_CALL", amount: { value: 0.0012, currency: "USD" } },
  input: { body: { keyword: "string", location_code: "number" } },
};
const done = (output: unknown, micro = 1200) => ({ runId: "run_1", status: "COMPLETED", output, providerResponse: { httpStatus: 200 }, billing: { reportedCost: { value: micro, unit: "MICRO_DOLLAR" } } });

const jobsAssistant = Assistant.parse({
  id: "jobs",
  connector: "monid",
  tool: "dataforseo/serp/google-jobs",
  input: { body: { keyword: "{{ask}}", location_code: 2356, depth: 20 } },
});

describe("the Monid connector", () => {
  beforeEach(() => {
    process.env.MONID_API_KEY = KEY;
  });

  it("puts the request into the input template, runs the tool, and reports what Monid charged", async () => {
    const { fetcher, calls } = fakeMonid({ tools: { "dataforseo/serp/google-jobs": JOBS }, states: [done({ items: [{ title: "Backend engineer" }] })] });
    const answer = await monid(fetcher).send({ assistant: jobsAssistant, ask: "backend engineer bengaluru", memory: [] });
    assert.deepEqual(
      calls.map((call) => call.path),
      ["/v1/inspect", "/v1/run"],
    );
    assert.equal(calls[1]?.auth, `Bearer ${KEY}`);
    assert.deepEqual(calls[1]?.body, { provider: "dataforseo", endpoint: "/serp/google-jobs", input: { body: { keyword: "backend engineer bengaluru", location_code: 2356, depth: 20 } } });
    assert.match(answer.text, /^dataforseo\/serp\/google-jobs answered \(Monid charged \$0\.0012\):/);
    assert.deepEqual(answer.data, { tool: "dataforseo/serp/google-jobs", run: "run_1", costUsd: 0.0012, output: { items: [{ title: "Backend engineer" }] } });
    assert.deepEqual(answer.usage, { inputTokens: 0, outputTokens: 0, costUsd: 0.0012 });
  });

  it("takes a JSON request as the whole input, and remembers a tool's details between runs", async () => {
    const { fetcher, calls } = fakeMonid({ tools: { "dataforseo/serp/google-jobs": JOBS }, states: [done([])] });
    const connector = monid(fetcher);
    await connector.send({ assistant: jobsAssistant, ask: '{"body":{"keyword":"nurse","location_code":2356}}', memory: [] });
    await connector.send({ assistant: jobsAssistant, ask: "teacher", memory: [] });
    assert.deepEqual(calls[1]?.body, { provider: "dataforseo", endpoint: "/serp/google-jobs", input: { body: { keyword: "nurse", location_code: 2356 } } });
    assert.equal(calls.filter((call) => call.path === "/v1/inspect").length, 1);
  });

  it("waits for a slow tool, looking again until it's done", async () => {
    const working = { runId: "run_1", status: "RUNNING" };
    const { fetcher, calls } = fakeMonid({ tools: { "dataforseo/serp/google-jobs": JOBS }, states: [working, working, done({ ok: true })] });
    const answer = await monid(fetcher, { pollMs: 1 }).send({ assistant: jobsAssistant, ask: "nurse", memory: [] });
    assert.equal(calls.filter((call) => call.path === "/v1/runs/run_1").length, 2);
    assert.deepEqual((answer.data as { output: unknown }).output, { ok: true });
  });

  it("gives up on a tool still working past the wait, naming the run", async () => {
    const { fetcher } = fakeMonid({ tools: { "dataforseo/serp/google-jobs": JOBS }, states: [{ runId: "run_9", status: "RUNNING" }] });
    await assert.rejects(monid(fetcher, { waitMs: 5, pollMs: 1 }).send({ assistant: jobsAssistant, ask: "nurse", memory: [] }), /still working after 0 s \(Monid run run_9\)/);
  });

  it("won't run past the assistant's spend cap, or a tool it can't price without one", async () => {
    const reviews = { description: "Reviews of a place.", tags: [], price: { type: "PER_RESULT", amount: { value: 0.002 } }, input: {} };
    const { fetcher, calls } = fakeMonid({ tools: { "apify/reviews": reviews, "acme/quote": { description: "A quote.", tags: [], price: { type: "DYNAMIC" } } }, states: [done([])] });
    const capped = Assistant.parse({ id: "reviews", connector: "monid", tool: "apify/reviews", input: { body: { place: "{{ask}}", maxReviews: 200 } } });
    await assert.rejects(monid(fetcher).send({ assistant: capped, ask: "Toit, Bengaluru", memory: [] }), /may cost about \$0\.4000 \(\$0\.002 a result\), over this assistant's \$0\.1 a run/);
    const unpriced = Assistant.parse({ id: "quote", connector: "monid", tool: "acme/quote", input: { body: { q: "{{ask}}" } } });
    await assert.rejects(monid(fetcher).send({ assistant: unpriced, ask: "x", memory: [] }), /can't say what acme\/quote costs before it runs.*spend cap \(maxUsd\)/);
    assert.equal(calls.filter((call) => call.path === "/v1/run").length, 0, "nothing ran");
    await monid(fetcher).send({ assistant: { ...unpriced, maxUsd: 0.5 }, ask: "x", memory: [] });
    assert.equal(calls.filter((call) => call.path === "/v1/run").length, 1);
  });

  it("won't run a tool that scrapes LinkedIn or finds personal contact details", async () => {
    const scraper = { description: "Scrape LinkedIn profiles in bulk.", tags: ["linkedin"], price: { type: "PER_CALL", amount: { value: 0.01 } }, input: {} };
    const { fetcher, calls } = fakeMonid({ tools: { "acme/people": scraper } });
    const assistant = Assistant.parse({ id: "people", connector: "monid", tool: "acme/people", input: { body: { q: "{{ask}}" } } });
    await assert.rejects(monid(fetcher).send({ assistant, ask: "x", memory: [] }), /won't run acme\/people: it scrapes a site whose terms forbid scraping/);
    assert.equal(calls.filter((call) => call.path === "/v1/run").length, 0);
  });

  it("says what failed, and never repeats the key", async () => {
    const failed = { runId: "run_2", status: "FAILED", providerResponse: { httpStatus: 401, error: { message: `bad key ${KEY}` } } };
    const { fetcher } = fakeMonid({ tools: { "dataforseo/serp/google-jobs": JOBS }, states: [failed] });
    await assert.rejects(monid(fetcher).send({ assistant: jobsAssistant, ask: "nurse", memory: [] }), (error: Error) => {
      assert.match(error.message, /dataforseo\/serp\/google-jobs failed: bad key \[key\]\./);
      assert.doesNotMatch(error.message, new RegExp(KEY));
      return true;
    });
  });

  it("asks for the key, a tool, and input it can use", async () => {
    delete process.env.MONID_API_KEY;
    const { fetcher } = fakeMonid({ tools: { "dataforseo/serp/google-jobs": JOBS } });
    await assert.rejects(monid(fetcher).send({ assistant: jobsAssistant, ask: "x", memory: [] }), /MONID_API_KEY environment variable/);
    process.env.MONID_API_KEY = KEY;
    await assert.rejects(monid(fetcher).send({ assistant: { ...jobsAssistant, tool: "nope" }, ask: "x", memory: [] }), /names no tool/);
    const bare = Assistant.parse({ id: "jobs", connector: "monid", tool: "dataforseo/serp/google-jobs" });
    assert.throws(() => monidInput(bare, "nurse"), /needs its input as JSON \(see `huddle monid show dataforseo\/serp\/google-jobs`\), or an input template/);
    await assert.rejects(monid(fetcher).send({ assistant: { ...bare, tool: "dataforseo/no-such" }, ask: "{}", memory: [] }), /Monid has no tool called dataforseo\/no-such/);
  });

  it("is a problem in a flow without a tool", () => {
    assert.deepEqual(assistantProblems(Assistant.parse({ id: "m", connector: "monid" })), ['assistant "m" is a Monid tool: say which one (tool), as provider/endpoint; `huddle monid find` lists them']);
    assert.throws(() => Assistant.parse({ id: "m", connector: "monid", tool: "no slash" }));
  });
});

describe("Monid's catalog", () => {
  it("finds tools for a need, best first, with their prices", async () => {
    const { fetcher, calls } = fakeMonid({ found: [{ provider: "dataforseo", endpoint: "/serp/google-jobs", description: "Google Jobs", price: JOBS.price, score: 0.82 }, { provider: "", endpoint: "/x" }] });
    const found = await monidClient(KEY, fetcher).find("job listings in India");
    assert.equal(found.length, 1);
    assert.equal(toolId(found[0]!), "dataforseo/serp/google-jobs");
    assert.equal(found[0]?.score, 0.82);
    assert.equal((calls[0]?.body as { query: string }).query, "job listings in India");
  });

  it("lists a tool's fields from its schema, and starts an input template with the request in the first required text", () => {
    const input = {
      body: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "Search query, up to 700 characters." },
          location_code: { type: "integer", description: "Numeric location code, e.g. 2840 (United States)." },
          depth: { type: "integer", description: "Results to collect (1-200, default 10)." },
        },
        required: ["keyword", "location_code"],
      },
      bodyType: "json",
    };
    assert.deepEqual(
      inputFields(input).map((field) => `${field.group}.${field.name}:${field.type}${field.required ? "*" : ""}`),
      ["body.keyword:string*", "body.location_code:integer*", "body.depth:integer"],
    );
    assert.deepEqual(starterInput(input), { body: { keyword: "{{ask}}", location_code: "<location_code: integer>" } });
    assert.deepEqual(starterInput({}), {});
  });

  it("reads ids, prices and costs the way people write them", () => {
    assert.deepEqual(parseTool("dataforseo/serp/google-jobs"), { provider: "dataforseo", endpoint: "/serp/google-jobs" });
    assert.equal(parseTool("nope"), null);
    assert.equal(priceText({ type: "PER_CALL", amount: { value: 0.05 } }), "$0.05 a run");
    assert.equal(priceText({ type: "PER_RESULT", amount: { value: 0.0003 } }), "$0.0003 a result");
    assert.equal(estimateUsd({ type: "PER_RESULT", amount: { value: 0.001 } }, { body: { maxItems: 50 } }), 0.05);
    assert.equal(estimateUsd({ type: "DYNAMIC" }), null);
    assert.equal(blockedReason({ provider: "acme", endpoint: "/sms/send", description: "Send SMS messages to a list", tags: [] }), "it contacts people");
    assert.equal(blockedReason({ provider: "dataforseo", endpoint: "/serp/google-jobs", description: JOBS.description, tags: JOBS.tags }), null);
  });
});
