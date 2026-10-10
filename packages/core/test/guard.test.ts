import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Connector, type ConnectorRequest } from "../src/connector.ts";
import { mock } from "../src/connectors/mock.ts";
import { Engine } from "../src/engine.ts";
import type { Guard, HandOff, Outcome, Verdict } from "../src/guard.ts";
import { parseFlow } from "../src/schema.ts";
import { Store } from "../src/store.ts";

const flow = parseFlow({
  name: "Plan and remind",
  assistants: [
    { id: "planner", connector: "mock", replies: { "*": "Plan done." } },
    { id: "mailer", connector: "email", to: ["me@example.com"], from: "Huddle <huddle@example.com>" },
  ],
  steps: [
    { id: "plan", type: "agent", agent: "planner", ask: "Plan: {{input}}" },
    { id: "send", type: "agent", agent: "mailer", ask: "{{plan.text}}" },
  ],
});

/** Says what it's told per assistant, and remembers what it saw. */
function fakeGuard(say: Record<string, Verdict["action"]>) {
  const checked: string[] = [];
  const reported: { assistant: string; outcome: Outcome }[] = [];
  const finished: string[] = [];
  const guard: Guard = {
    name: "Fake",
    async check({ assistant }: HandOff) {
      checked.push(assistant.id);
      const action = say[assistant.id] ?? "allow";
      return { action, reason: action === "allow" ? "fine" : action === "block" ? `${assistant.id} is blocked` : `${assistant.id} needs a yes` };
    },
    async report({ assistant }, outcome) {
      reported.push({ assistant: assistant.id, outcome });
    },
    async finish(runId, state) {
      finished.push(`${runId}:${state}`);
    },
  };
  return { guard, checked, reported, finished };
}

const sent: ConnectorRequest[] = [];
const email: Connector = {
  async send(request) {
    sent.push(request);
    return { text: "Sent." };
  },
};

describe("a guard", () => {
  it("is asked before every hand-off, told how each went, and told when the run is over", async () => {
    const store = new Store();
    const { guard, checked, reported, finished } = fakeGuard({});
    const view = await new Engine(store, { mock, email }, { guard }).start(flow, "the week");
    assert.equal(view.state, "done");
    assert.deepEqual(checked, ["planner", "mailer"]);
    assert.deepEqual(reported.map((r) => [r.assistant, r.outcome.ok, r.outcome.chars]), [["planner", true, 10], ["mailer", true, 5]]);
    assert.deepEqual(finished, [`${view.id}:done`]);
    assert.deepEqual(store.logOf(view.id).map((line) => `${line.stepId}:${line.kind}`), ["plan:guarded", "plan:asked", "plan:answered", "send:guarded", "send:asked", "send:answered"]);
  });

  it("stops a blocked hand-off before the assistant hears about it, and fails the run with the reason", async () => {
    const store = new Store();
    sent.length = 0;
    const { guard, finished } = fakeGuard({ mailer: "block" });
    const view = await new Engine(store, { mock, email }, { guard }).start(flow, "the week");
    assert.equal(view.state, "failed");
    assert.equal(view.at, "send");
    assert.match(view.error ?? "", /Fake stopped the hand-off to "mailer": mailer is blocked/);
    assert.equal(sent.length, 0);
    assert.deepEqual(finished, [`${view.id}:failed`]);
  });

  it("holds a hand-off for your yes, then makes it without asking the guard again", async () => {
    const store = new Store();
    sent.length = 0;
    const { guard, checked } = fakeGuard({ mailer: "hold" });
    const engine = new Engine(store, { mock, email }, { guard });
    const waiting = await engine.start(flow, "the week");
    assert.equal(waiting.state, "waiting");
    assert.equal(waiting.at, "send");
    assert.match(waiting.waiting?.message ?? "", /Fake held the hand-off to "mailer" \(mailer needs a yes\)\. Let it go ahead\?/);
    assert.equal(sent.length, 0);

    const done = await engine.decide(waiting.waiting!.id, true);
    assert.equal(done.state, "done");
    assert.equal(done.context.steps.send?.text, "Sent.");
    assert.equal(sent.length, 1);
    assert.deepEqual(checked, ["planner", "mailer"]);
    assert.deepEqual(store.logOf(done.id).map((line) => `${line.stepId}:${line.kind}`).slice(3), ["send:guarded", "send:waiting", "send:approved", "send:asked", "send:answered"]);
  });

  it("ends the run as declined when you say no to a held hand-off", async () => {
    const store = new Store();
    sent.length = 0;
    const { guard, finished } = fakeGuard({ mailer: "hold" });
    const engine = new Engine(store, { mock, email }, { guard });
    const waiting = await engine.start(flow, "the week");
    const declined = await engine.decide(waiting.waiting!.id, false);
    assert.equal(declined.state, "declined");
    assert.equal(sent.length, 0);
    assert.deepEqual(finished, [`${declined.id}:declined`]);
  });

  it("is told when an assistant fails, and the run still fails with the assistant's error", async () => {
    const store = new Store();
    const { guard, reported } = fakeGuard({});
    const broken: Connector = { send: async () => { throw new Error("mail server down"); } };
    const view = await new Engine(store, { mock, email: broken }, { guard }).start(flow, "the week");
    assert.equal(view.state, "failed");
    assert.equal(view.error, "mail server down");
    assert.deepEqual(reported.map((r) => [r.assistant, r.outcome.ok, r.outcome.error]), [["planner", true, undefined], ["mailer", false, "mail server down"]]);
  });
});
