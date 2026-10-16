import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contextdev } from "../src/connectors/contextdev.ts";
import { CONTEXT_DEV_CREDIT_USD, taskFor } from "../src/contextdev.ts";
import { Assistant, assistantProblems } from "../src/schema.ts";

const KEY = "ctx_test_key_123456";

/** context.dev's API as the SDK sees it: answers by path, and records what was asked. */
function api(answer: (path: string, body: Record<string, unknown>) => Response) {
  const asked: { path: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    asked.push({ path, body, auth: new Headers(init?.headers).get("authorization") });
    return answer(path, body);
  }) as typeof fetch;
  return { fetcher, asked };
}

const assistant = (agentId?: string) => Assistant.parse({ id: "web", connector: "contextdev", memory: ["me"], ...(agentId ? { agentId } : {}) });

async function withKey<T>(work: () => Promise<T>): Promise<T> {
  process.env.CONTEXT_DEV_API_KEY = KEY;
  try {
    return await work();
  } finally {
    delete process.env.CONTEXT_DEV_API_KEY;
  }
}

describe("context.dev", () => {
  it("works out what a request asks for", () => {
    assert.deepEqual(taskFor("https://www.mysorepalace.gov.in/tickets"), { kind: "read", url: "https://www.mysorepalace.gov.in/tickets", question: null });
    assert.deepEqual(taskFor("What does an adult ticket cost? https://example.com/palace."), { kind: "read", url: "https://example.com/palace", question: "What does an adult ticket cost?" });
    assert.deepEqual(taskFor("priya@zerodha.com"), { kind: "company", by: "email", value: "priya@zerodha.com" });
    assert.deepEqual(taskFor("www.Zerodha.com"), { kind: "company", by: "domain", value: "zerodha.com" });
    assert.deepEqual(taskFor("trains from Bengaluru to Mysuru on Saturday"), { kind: "search", query: "trains from Bengaluru to Mysuru on Saturday" });
    assert.deepEqual(taskFor("An email from priya@zerodha.com: who are they?", "company"), { kind: "company", by: "email", value: "priya@zerodha.com" });
    assert.deepEqual(taskFor("Zerodha", "company"), { kind: "company", by: "name", value: "Zerodha" });
    assert.deepEqual(taskFor("example.com", "read"), { kind: "read", url: "https://example.com", question: null });
    assert.deepEqual(taskFor("read https://example.com", "search"), { kind: "search", query: "read https://example.com" });
    assert.throws(() => taskFor("the palace's ticket price", "read"), /a link to read/);
  });

  it("reads a page through the SDK, just the passages that answer the question, and never sends memory", async () => {
    const { fetcher, asked } = api(() =>
      Response.json({
        url: "https://example.com/palace",
        markdown: { requested: true, success: true, data: "# Mysore Palace\n\nLots of history…\n\n## Tickets\n\nAdults: Rs. 120" },
        highlights: { requested: true, success: true, data: ["[Mysore Palace > Tickets]\n\nAdults: Rs. 120"] },
        metadata: { title: "Mysore Palace" },
        key_metadata: { credits_consumed: 2, credits_remaining: 998 },
        request_id: "r1",
      }),
    );
    const reply = await withKey(() => contextdev(fetcher).send({ assistant: assistant(), ask: "What does an adult ticket cost? https://example.com/palace", memory: [{ id: "n", slice: "me", note: "Lives in Bengaluru", status: "kept", source: "you", createdAt: "" }] }));
    assert.equal(asked.length, 1);
    assert.equal(asked[0]!.path, "/v1/web/scrape");
    assert.equal(asked[0]!.auth, `Bearer ${KEY}`);
    assert.deepEqual(asked[0]!.body.formats, { markdown: true, highlights: true });
    assert.deepEqual(asked[0]!.body.highlightsParams, { query: "What does an adult ticket cost?", maxCharacters: 3000 });
    assert.ok(!JSON.stringify(asked[0]!.body).includes("Bengaluru"), "memory stays home");
    assert.equal(reply.text, "Mysore Palace (https://example.com/palace)\n\n[Mysore Palace > Tickets]\n\nAdults: Rs. 120");
    assert.equal((reply.data as { did: string }).did, "read");
    assert.equal(reply.usage?.costUsd, 2 * CONTEXT_DEV_CREDIT_USD);
  });

  it("searches, with each result's passages, or its description when the page couldn't be read", async () => {
    const { fetcher, asked } = api(() =>
      Response.json({
        query: "Tippu Express timings",
        results: [
          { url: "https://a.example", title: "Timetable", description: "Departs 06:00", relevance: "high", highlights: { code: "SUCCESS", highlights: ["12609 departs KSR Bengaluru at 06:00"] }, markdown: { code: "NOT_REQUESTED", markdown: null } },
          { url: "https://b.example", title: "Blocked", description: "A forum thread", relevance: "low", highlights: { code: "WEBSITE_BLOCKED", highlights: null }, markdown: { code: "NOT_REQUESTED", markdown: null } },
        ],
        key_metadata: { credits_consumed: 2, credits_remaining: 996 },
        cache_metadata: { status: "miss", age_ms: 0 },
        request_id: "r2",
      }),
    );
    const reply = await withKey(() => contextdev(fetcher).send({ assistant: assistant("search"), ask: "Tippu Express timings", memory: [] }));
    assert.equal(asked[0]!.path, "/v1/web/search");
    assert.deepEqual(asked[0]!.body.highlightsOptions, { enabled: true, maxCharacters: 800 });
    assert.equal(reply.text, "1. Timetable (https://a.example)\n12609 departs KSR Bengaluru at 06:00\n\n2. Blocked (https://b.example)\nA forum thread");
  });

  it("looks a company up, and a personal address or an unknown site isn't a failure", async () => {
    const { fetcher, asked } = api((_path, body) => {
      if (body.email === "me@gmail.com") return Response.json({ message: "Freemail email addresses are not allowed", status: "error", error_code: "FREE_EMAIL_DETECTED" }, { status: 422 });
      if (body.domain === "nowhere.example") return Response.json({ message: "Domain branding not present", status: "error", error_code: "WEBSITE_NOT_FOUND" }, { status: 400 });
      return Response.json({
        status: "ok",
        code: 200,
        brand: {
          domain: "zerodha.com",
          title: "Zerodha",
          description: "India's largest discount brokerage.",
          industries: { eic: [{ industry: "Finance", subindustry: "Brokerage" }] },
          address: { city: "Bengaluru", country: "India" },
          employees: { range: "1001 to 5000" },
          socials: [{ type: "x", url: "https://x.com/zerodhaonline" }],
          logos: [{ url: "https://media.example/logo.svg", type: "logo", mode: "light" }],
        },
        key_metadata: { credits_consumed: 10, credits_remaining: 986 },
        request_id: "r3",
        cache_metadata: { status: "hit", age_ms: 5 },
      });
    });
    const send = (ask: string) => withKey(() => contextdev(fetcher).send({ assistant: assistant("company"), ask, memory: [] }));

    const found = await send("A message from priya@zerodha.com about my account");
    assert.deepEqual(asked[0]!.body, { type: "by_email", email: "priya@zerodha.com", timeoutOpts: { milliseconds: 60000, behavior: "return-partial" } });
    assert.equal(found.text, "Zerodha (zerodha.com): India's largest discount brokerage.\nIndustry: Finance\nBased in Bengaluru, India\nEmployees: 1001 to 5000\nElsewhere: https://x.com/zerodhaonline");
    assert.equal((found.data as { found: boolean; logo: string }).logo, "https://media.example/logo.svg");
    assert.equal(found.usage?.costUsd, 10 * CONTEXT_DEV_CREDIT_USD);

    const personal = await send("me@gmail.com");
    assert.equal((personal.data as { found: boolean }).found, false);
    assert.match(personal.text, /personal email address/);
    const unknown = await send("nowhere.example");
    assert.equal((unknown.data as { why: string }).why, "not found");
  });

  it("says plainly what went wrong, and never shows the key", async () => {
    const { fetcher } = api(() => Response.json({ message: `API key ${KEY} not found`, error_code: "NOT_FOUND" }, { status: 401 }));
    await assert.rejects(
      withKey(() => contextdev(fetcher).send({ assistant: assistant("company"), ask: "zerodha.com", memory: [] })),
      (error: Error) => error.message === "context.dev didn't accept the key." && !error.message.includes(KEY),
    );
    const { fetcher: spent } = api(() => Response.json({ message: "Usage exceeded", error_code: "USAGE_EXCEEDED" }, { status: 401 }));
    await assert.rejects(withKey(() => contextdev(spent).send({ assistant: assistant(), ask: "https://example.com", memory: [] })), /used up for the month/);
    const { fetcher: empty } = api(() => Response.json({ url: "https://example.com", markdown: { requested: true, success: false, data: null, error_code: "WEBSITE_ACCESS_ERROR", message: "The page could not be retrieved." }, key_metadata: { credits_consumed: 0, credits_remaining: 1 } }));
    await assert.rejects(withKey(() => contextdev(empty).send({ assistant: assistant(), ask: "https://example.com", memory: [] })), /couldn't read https:\/\/example\.com: The page could not be retrieved/);
    await assert.rejects(contextdev(empty).send({ assistant: assistant(), ask: "https://example.com", memory: [] }), /CONTEXT_DEV_API_KEY/);
  });

  it("only takes read, search or company as what it does", () => {
    assert.deepEqual(assistantProblems(assistant("company")), []);
    assert.match(assistantProblems(assistant("scrape")).join(""), /read, search, company/);
  });
});
