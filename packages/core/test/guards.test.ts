import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Connector } from "../src/connector.ts";
import { mock } from "../src/connectors/mock.ts";
import { Engine } from "../src/engine.ts";
import { httpGuard } from "../src/guards/http.ts";
import { guardFromEnv } from "../src/guards/index.ts";
import { parseFlow } from "../src/schema.ts";
import { Store } from "../src/store.ts";

const flow = parseFlow({
  name: "Mail my plan",
  assistants: [
    { id: "planner", connector: "mock", replies: { "*": "Plan done." } },
    { id: "mailer", connector: "email", to: ["me@example.com"], from: "Huddle <huddle@example.com>" },
  ],
  steps: [
    { id: "plan", type: "agent", agent: "planner", ask: "Plan: {{input}}" },
    { id: "send", type: "agent", agent: "mailer", ask: "{{plan.text}}" },
  ],
});
const email: Connector = { send: async () => ({ text: "Sent." }) };

describe("choosing a guard", () => {
  it("has none unless HUDDLE_GUARD names one, even with an ArmorIQ key about", () => {
    assert.equal(guardFromEnv({}), null);
    assert.equal(guardFromEnv({ ARMORIQ_API_KEY: "ak_test_x" }), null);
    assert.equal(guardFromEnv({ HUDDLE_GUARD: "none" }), null);
  });

  it("switches ArmorIQ or your own service on by name, and says what's missing", () => {
    assert.equal(guardFromEnv({ HUDDLE_GUARD: "armoriq", ARMORIQ_API_KEY: "ak_test_x" })?.name, "ArmorIQ");
    assert.throws(() => guardFromEnv({ HUDDLE_GUARD: "armoriq" }), /needs ARMORIQ_API_KEY/);
    assert.equal(guardFromEnv({ HUDDLE_GUARD: "http", HUDDLE_GUARD_URL: "https://policy.example.com/check" })?.name, "Your guard");
    assert.throws(() => guardFromEnv({ HUDDLE_GUARD: "http" }), /needs HUDDLE_GUARD_URL/);
    assert.throws(() => guardFromEnv({ HUDDLE_GUARD: "http", HUDDLE_GUARD_URL: "https://x.test", HUDDLE_GUARD_ON_FAILURE: "maybe" }), /block or allow/);
    assert.throws(() => guardFromEnv({ HUDDLE_GUARD: "opa" }), /There's no "opa" guard\. HUDDLE_GUARD is one of: armoriq, http/);
  });
});

describe("your own guard over HTTP", () => {
  /** A policy service that answers per connector, and records what it was sent. */
  function service(answer: (connector: string) => unknown, status = 200) {
    const asked: { body: Record<string, unknown>; auth: string | null }[] = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      asked.push({ body, auth: (init.headers as Record<string, string>).authorization ?? null });
      return Response.json(answer(String(body.connector)), { status });
    }) as typeof fetch;
    return { fetcher, asked };
  }

  it("is asked about each hand-off, without the ask or the answer, and its hold waits in Huddle's Approvals", async () => {
    const { fetcher, asked } = service((connector) => (connector === "email" ? { action: "hold", reason: "email needs a yes" } : { action: "allow" }));
    const store = new Store();
    const engine = new Engine(store, { mock, email }, { guard: httpGuard({ url: "https://policy.example.com/check", key: "secret", fetcher }) });
    const waiting = await engine.start(flow, "my private plans");
    assert.equal(waiting.state, "waiting");
    assert.equal(waiting.waiting?.heldBy, null, "Huddle's own approval: a yes here lets it through");
    assert.match(waiting.waiting?.message ?? "", /Your guard held the hand-off to "mailer" \(email needs a yes\)\. Let it go ahead\?/);
    assert.deepEqual(asked[1]?.body, { flow: "Mail my plan", run: waiting.id, step: "send", assistant: "mailer", connector: "email" });
    assert.equal(asked[1]?.auth, "Bearer secret");
    assert.ok(!JSON.stringify(asked).includes("private"), "never the ask");
    assert.equal((await engine.decide(waiting.waiting!.id, true)).state, "done");
  });

  it("stops a hand-off it blocks, with its reason", async () => {
    const { fetcher } = service(() => ({ action: "block", reason: "no email after 10pm" }));
    const view = await new Engine(new Store(), { mock, email }, { guard: httpGuard({ url: "https://policy.example.com/check", fetcher }) }).start(flow, "x");
    assert.equal(view.state, "failed");
    assert.equal(view.error, 'Your guard stopped the hand-off to "planner": no email after 10pm.');
  });

  it("fails closed when the service is down or answers nonsense, unless you let hand-offs through then", async () => {
    const down = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const closed = await new Engine(new Store(), { mock, email }, { guard: httpGuard({ url: "https://policy.example.com/check", fetcher: down }) }).start(flow, "x");
    assert.match(closed.error ?? "", /policy\.example\.com couldn't be asked, so it didn't go ahead: connect ECONNREFUSED/);
    const nonsense = service(() => ({ verdict: "sure" }));
    const odd = await new Engine(new Store(), { mock, email }, { guard: httpGuard({ url: "https://policy.example.com/check", fetcher: nonsense.fetcher }) }).start(flow, "x");
    assert.match(odd.error ?? "", /its answer had no "action" of allow, block or hold/);
    const open = await new Engine(new Store(), { mock, email }, { guard: httpGuard({ url: "https://policy.example.com/check", fetcher: down, onFailure: "allow" }) }).start(flow, "x");
    assert.equal(open.state, "done");
  });
});
