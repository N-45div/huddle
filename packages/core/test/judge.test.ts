import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mock } from "../src/connectors/mock.ts";
import { Engine } from "../src/engine.ts";
import { jevJudge, type Judge, modelJudge } from "../src/judge.ts";
import { NoAnswer, Router } from "../src/router.ts";
import { Assistant } from "../src/schema.ts";
import { Store } from "../src/store.ts";

const candidates = [
  { id: "hermes", description: "Plans my week and writes reminders." },
  { id: "claw", description: "Handles work: meetings, docs, code." },
  { id: "home", description: "Turns lights and heating on and off." },
];

describe("the judge", () => {
  it("asks Jev one Choice question over your assistants and ranks them by its probabilities", async () => {
    let sent: { url: string; auth: string; body: Record<string, unknown> } | undefined;
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      sent = { url: String(url), auth: String((init?.headers as Record<string, string>).authorization), body: JSON.parse(String(init?.body)) };
      return Response.json({ model: "jev-1.13.0", answers: { route: { type: "choice", choice: "claw", probabilities: { claw: 0.71, hermes: 0.26, home: 0.03 }, confidence: 0.64 } }, usage: { input_tokens: 120, output_tokens: 3 } });
    }) as typeof fetch;
    const ranking = await jevJudge({ key: "ts-key", fetcher }).rank("Move my 3pm standup to Thursday", candidates);
    assert.equal(sent?.url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(sent?.auth, "Bearer ts-key");
    assert.equal(sent?.body.model, "jev-latest");
    assert.equal(sent?.body.state, "Move my 3pm standup to Thursday");
    const route = (sent?.body.questions as Record<string, { type: string; criteria: Record<string, string> }>).route;
    assert.equal(route?.type, "choice");
    assert.deepEqual(route?.criteria, { hermes: "Plans my week and writes reminders.", claw: "Handles work: meetings, docs, code.", home: "Turns lights and heating on and off." });
    assert.deepEqual(ranking, { judge: "jev", order: ["claw", "hermes", "home"], probabilities: { claw: 0.71, hermes: 0.26, home: 0.03 }, confidence: 0.64, model: "jev-1.13.0" });
  });

  it("keeps the key out of Jev's errors, and won't take an answer that names no assistant", async () => {
    const refused = (async () => Response.json({ error: "invalid key ts-key" }, { status: 401 })) as typeof fetch;
    await assert.rejects(jevJudge({ key: "ts-key", fetcher: refused }).rank("x", candidates), /Jev said: invalid key \[key\]/);
    const odd = (async () => Response.json({ answers: { route: { choice: "nobody", probabilities: { nobody: 1 } } } })) as typeof fetch;
    await assert.rejects(jevJudge({ key: "k", fetcher: odd }).rank("x", candidates), /without a choice/);
    await assert.rejects(jevJudge({ key: "k", fetcher: odd }).rank("x", Array.from({ length: 256 }, (_, n) => ({ id: `a${n}`, description: "" }))), /at most 255/);
  });

  it("can ask any OpenAI-compatible model for a ranking instead, keeping only your assistants", async () => {
    const fetcher = (async () => Response.json({ model: "gpt-5.4-mini", choices: [{ message: { content: 'Sure: {"ranking": ["home", "ghost", "hermes"]}' } }] })) as typeof fetch;
    const ranking = await modelJudge({ url: "http://model.test/v1", model: "gpt-5.4-mini", fetcher }).rank("Too dark in here", candidates);
    assert.deepEqual(ranking.order, ["home", "hermes", "claw"], "unknown ids dropped, the rest kept after");
    assert.equal(ranking.probabilities, null);
    const babble = (async () => Response.json({ choices: [{ message: { content: "I think the home one?" } }] })) as typeof fetch;
    await assert.rejects(modelJudge({ url: "http://model.test/v1", model: "m", fetcher: babble }).rank("x", candidates), /didn't answer with a ranking/);
  });
});

describe('the router with model "auto"', () => {
  function setup(judge: Judge | null) {
    const store = new Store();
    store.saveAssistants([
      Assistant.parse({ id: "hermes", connector: "mock", description: "Plans my week.", replies: { "*": "Hermes here." } }),
      Assistant.parse({ id: "claw", connector: "http", url: "http://claw.test", description: "Work." }),
      Assistant.parse({ id: "home", connector: "mock", replies: { "*": "Lights off." } }),
    ]);
    // claw is down: its connector always fails.
    const engine = new Engine(store, { mock, http: { send: async () => Promise.reject(new Error("claw is offline")) } });
    return new Router(store, engine, judge);
  }
  const judging = (order: string[], probabilities: Record<string, number> | null): Judge => ({ name: "test", rank: async () => ({ judge: "test", order, probabilities, confidence: 0.5, model: "test-1" }) });

  it("asks the judge's pick first, falls back down its ranking, and says how it routed", async () => {
    const routed = await setup(judging(["claw", "hermes", "home"], { claw: 0.6, hermes: 0.35, home: 0.05 })).answer({ model: "auto", ask: "Move standup" });
    assert.equal(routed.assistant.id, "hermes", "claw was picked but is down, so the next");
    assert.deepEqual(routed.skipped.map((skip) => skip.id), ["claw"]);
    assert.deepEqual(routed.route?.order, ["claw", "hermes", "home"]);
    assert.equal(routed.route?.judge, "test");
  });

  it("doesn't try assistants the judge all but ruled out", async () => {
    const router = setup(judging(["claw", "home", "hermes"], { claw: 0.97, home: 0.02, hermes: 0.01 }));
    await assert.rejects(router.answer({ model: "auto", ask: "Book a work meeting" }), (error: NoAnswer) => {
      assert.deepEqual(error.tried.map((attempt) => attempt.id), ["claw"]);
      return true;
    });
  });

  it("uses your list's order when the judge fails or there's none, and chooses only among `models` when given", async () => {
    const broken: Judge = { name: "jev", rank: async () => Promise.reject(new Error("Jev said: HTTP 529")) };
    const fallback = await setup(broken).answer({ model: "auto", ask: "hi" });
    assert.equal(fallback.assistant.id, "hermes");
    assert.match(fallback.route?.note ?? "", /The judge \(jev\) failed, so your list's order: Jev said: HTTP 529/);
    const none = await setup(null).answer({ model: "auto", models: ["home", "claw"], ask: "hi" });
    assert.equal(none.assistant.id, "home");
    assert.deepEqual(none.route?.order, ["claw", "home"], "your list's order, among the ones allowed");
    assert.equal(none.route?.judge, "order");
  });
});
