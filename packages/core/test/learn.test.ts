import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mock } from "../src/connectors/mock.ts";
import { Engine, LEARNING } from "../src/engine.ts";
import { alreadySays, type Learner, noteTaker } from "../src/memory/learn.ts";
import { receiptOf } from "../src/receipt.ts";
import { lastSaid } from "../src/router.ts";
import { parseFlow } from "../src/schema.ts";
import { Store } from "../src/store.ts";
import { NEMOTRON, TOKEN_FACTORY_URL } from "../src/tokenfactory.ts";

const SAID = "Plan a weekend in Mysuru for me and my wife Priya, by train, under ₹8,000. We're vegetarian.";

/** Token Factory answering with these notes, recording what it was sent. */
function tokenFactory(notes: unknown) {
  const sent: { system: string; user: string; thinking: unknown }[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: { content: string }[]; chat_template_kwargs?: unknown };
    sent.push({ system: body.messages[0]!.content, user: body.messages[1]!.content, thinking: body.chat_template_kwargs });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ notes }) } }], usage: { prompt_tokens: 400, completion_tokens: 60 } });
  }) as typeof fetch;
  return { learner: noteTaker({ model: { url: TOKEN_FACTORY_URL, model: NEMOTRON.lightning, key: "tf" }, fetcher }), sent };
}

const flow = parseFlow({
  name: "Weekend plan",
  assistants: [{ id: "planner", connector: "mock", memory: ["me"], replies: { "*": "Saturday: the palace. Sunday: Chamundi Hill." } }],
  steps: [{ id: "plan", type: "agent", agent: "planner", ask: "{{input}}" }],
});

/** Waits for the background learning to log its line. */
async function learnedLine(store: Store, runId: string) {
  for (let tries = 0; tries < 200; tries++) {
    const line = store.logOf(runId).find((one) => one.kind === "learned");
    if (line) return line;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("never learned");
}

describe("learning from what you say", () => {
  it("reads only your words and keeps only what you said: no names, places or numbers it made up, no secrets", async () => {
    const { learner, sent } = tokenFactory([
      { slice: "me", note: "Married to Priya" },
      { slice: "food", note: "Vegetarian" },
      { slice: "me", note: "Lives in Bengaluru" },
      { slice: "Money!", note: "Keeps weekend trips under ₹8,000" },
      { slice: "me", note: "Bank PIN is 4321" },
      { slice: "travel", note: "Prefers trains" },
      { slice: "travel", note: "Likes the palace" },
    ]);
    const learned = await learner.learn(SAID, ["me", "money"]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.user, SAID, "your words, and nothing else");
    assert.match(sent[0]!.system, /"me", "money"/);
    assert.deepEqual(sent[0]!.thinking, { enable_thinking: false });
    assert.deepEqual(
      learned.notes,
      [
        { slice: "me", note: "Married to Priya" },
        { slice: "food", note: "Vegetarian" },
        { slice: "travel", note: "Prefers trains" },
      ],
      "Bengaluru is a place they didn't say, the slice isn't a slice, a PIN is a secret, and three is the most",
    );
    assert.ok(learned.costUsd > 0);
    assert.equal(learner.to, "Nebius Token Factory (api.tokenfactory.nebius.com)");
  });

  it("knows a note memory already holds in other words", () => {
    assert.ok(alreadySays("Vegetarian, doesn't eat meat", ["Is vegetarian and doesn't eat meat or eggs"]));
    assert.equal(alreadySays("Married to Priya", ["Has a beagle called Biscuit"]), false);
    assert.equal(alreadySays("Has a cat", ["Has a dog"]), false, "short words are left to the exact check");
  });

  it("takes the last thing you said in a chat, never the replies", () => {
    assert.equal(lastSaid([{ role: "user", content: "I'm vegetarian." }, { role: "assistant", content: "Noted: you love steak." }, { role: "user", content: "Plan dinner." }]), "Plan dinner.");
  });

  it("does nothing until you turn it on, then suggests after the run, says so in the log and the receipt", async () => {
    const { learner, sent } = tokenFactory([{ slice: "me", note: "Married to Priya" }, { slice: "me", note: "Vegetarian" }]);
    const store = new Store();
    store.remember("me", "Is vegetarian and doesn't eat meat or eggs");
    const engine = new Engine(store, { mock }, { learner });

    const off = await engine.start(flow, SAID);
    engine.learnFrom(off.id, SAID);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(sent.length, 0, "off: nothing is read");

    store.saveSetting(LEARNING, "on");
    const on = await engine.start(flow, SAID);
    engine.learnFrom(on.id, SAID);
    const line = await learnedLine(store, on.id);
    assert.equal(sent.length, 1);
    const detail = line.detail as { notes: { text: string }[]; chars: number; by: string };
    assert.deepEqual(detail.notes.map((note) => note.text), ["Married to Priya"], "vegetarian is already known");
    assert.equal(detail.chars, SAID.length);
    const waiting = store.notes("suggested");
    assert.deepEqual(waiting.map((note) => [note.slice, note.note, note.source]), [["me", "Married to Priya", `learned from what you said in run ${on.id}`]]);

    const receipt = receiptOf(flow, store.logOf(on.id), store.notes());
    const learning = receipt.disclosures.find((disclosure) => disclosure.stepId === "learn");
    assert.equal(learning?.to.host, "api.tokenfactory.nebius.com");
    assert.equal(learning?.chars, SAID.length);
    assert.deepEqual(learning?.notes, [], "no notes were sent to learn");
    assert.ok(receipt.services.includes("api.tokenfactory.nebius.com"));
  });

  it("waits for a run that's waiting on you, and logs a failure instead of throwing", async () => {
    const calls: string[] = [];
    const learner: Learner = {
      by: "test",
      to: "nowhere",
      host: null,
      async learn(said) {
        calls.push(said);
        throw new Error("Token Factory is down");
      },
    };
    const store = new Store();
    store.saveSetting(LEARNING, "on");
    const engine = new Engine(store, { mock }, { learner });
    const asking = parseFlow({ name: "Ask first", steps: [{ id: "ok", type: "approval", message: "Go?" }] });
    const view = await engine.start(asking, SAID);
    engine.learnFrom(view.id, SAID);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 0, "not while it waits");
    await engine.decide(view.waiting!.id, true);
    const line = await learnedLine(store, view.id);
    assert.equal(calls.length, 1);
    assert.match(String((line.detail as { error: string }).error), /down/);
  });

  it("never reads a flow whose input isn't your own words (learn: false)", async () => {
    const { learner, sent } = tokenFactory([{ slice: "me", note: "Works at Zerodha" }]);
    const store = new Store();
    store.saveSetting(LEARNING, "on");
    const engine = new Engine(store, { mock }, { learner });
    const pasted = parseFlow({ ...flow, learn: false });
    const view = await engine.start(pasted, "From: Nithin <nithin@zerodha.com>\nHi, I'm Nithin and I run partnerships at Zerodha.");
    engine.learnFrom(view.id, "From: Nithin <nithin@zerodha.com>\nHi, I'm Nithin and I run partnerships at Zerodha.");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(sent.length, 0);
  });

  it("skips something too short to hold anything", async () => {
    const { learner, sent } = tokenFactory([]);
    const store = new Store();
    store.saveSetting(LEARNING, "on");
    const engine = new Engine(store, { mock }, { learner });
    const view = await engine.start(flow, "Today");
    engine.learnFrom(view.id, "Today");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sent.length, 0);
  });
});
