import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Connector, type ConnectorRequest } from "../src/connector.ts";
import { mock } from "../src/connectors/mock.ts";
import { Engine, HeldElsewhere } from "../src/engine.ts";
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

/** A guard whose holds only its own approver releases; the test says when, and what. */
function holdingGuard() {
  const checked: string[] = [];
  let release: (outcome: "approved" | "rejected" | "timeout") => void = () => {};
  const waits: string[] = [];
  const guard: Guard = {
    name: "ArmorIQ",
    async check({ assistant }: HandOff) {
      checked.push(assistant.id);
      return assistant.id === "mailer"
        ? { action: "hold", reason: "your policy wants a yes", heldBy: { by: "ArmorIQ", id: `del-${checked.length}`, url: "https://platform.armoriq.test/dashboard/plans/p1" } }
        : { action: "allow", reason: "fine" };
    },
    async report() {},
    async finish() {},
    awaitRelease(heldBy) {
      waits.push(heldBy.id);
      return new Promise((resolve) => (release = resolve));
    },
  };
  return { guard, checked, waits, release: (outcome: "approved" | "rejected" | "timeout") => release(outcome) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("a hold the guard's own approver releases (ArmorIQ)", () => {
  it("waits in Approvals with where to approve it, and refuses a yes from Huddle", async () => {
    const store = new Store();
    sent.length = 0;
    const { guard, waits } = holdingGuard();
    const engine = new Engine(store, { mock, email }, { guard });
    const waiting = await engine.start(flow, "the week");
    assert.equal(waiting.state, "waiting");
    assert.deepEqual(waiting.waiting?.heldBy, { by: "ArmorIQ", id: "del-2", url: "https://platform.armoriq.test/dashboard/plans/p1" });
    assert.match(waiting.waiting?.message ?? "", /Approve it in ArmorIQ; the run carries on by itself once you do\./);
    assert.deepEqual(waits, ["del-2"]);
    assert.throws(() => engine.answer(waiting.waiting!.id, true), HeldElsewhere);
    await assert.rejects(engine.decide(waiting.waiting!.id, true), /ArmorIQ holds this one: approve it in ArmorIQ \(https:\/\/platform\.armoriq\.test\/dashboard\/plans\/p1\)/);
    assert.equal(sent.length, 0);
  });

  it("carries on by itself when it's approved there, without asking the guard again", async () => {
    const store = new Store();
    sent.length = 0;
    const { guard, checked, release } = holdingGuard();
    const engine = new Engine(store, { mock, email }, { guard });
    const waiting = await engine.start(flow, "the week");
    release("approved");
    await settle();
    const done = engine.view(waiting.id);
    assert.equal(done.state, "done");
    assert.equal(sent.length, 1);
    assert.deepEqual(checked, ["planner", "mailer"]);
    assert.deepEqual(store.logOf(done.id).map((line) => `${line.stepId}:${line.kind}`).slice(3), ["send:guarded", "send:waiting", "send:released", "send:approved", "send:asked", "send:answered"]);
  });

  it("ends the run as declined when it's refused there, or the approval runs out", async () => {
    for (const outcome of ["rejected", "timeout"] as const) {
      const store = new Store();
      sent.length = 0;
      const { guard, release } = holdingGuard();
      const engine = new Engine(store, { mock, email }, { guard });
      const waiting = await engine.start(flow, "the week");
      release(outcome);
      await settle();
      assert.equal(engine.view(waiting.id).state, "declined", outcome);
      assert.equal(sent.length, 0);
      assert.equal(store.logOf(waiting.id).find((line) => line.kind === "refused")?.detail && (store.logOf(waiting.id).find((line) => line.kind === "refused")!.detail as { outcome: string }).outcome, outcome);
    }
  });

  it("lets you say no in Huddle first, and then an approval there changes nothing", async () => {
    const store = new Store();
    sent.length = 0;
    const { guard, release } = holdingGuard();
    const engine = new Engine(store, { mock, email }, { guard });
    const waiting = await engine.start(flow, "the week");
    assert.equal((await engine.decide(waiting.waiting!.id, false)).state, "declined");
    release("approved");
    await settle();
    assert.equal(engine.view(waiting.id).state, "declined");
    assert.equal(sent.length, 0);
  });

  it("picks the wait up again after a restart", async () => {
    const store = new Store();
    sent.length = 0;
    const first = holdingGuard();
    const waiting = await new Engine(store, { mock, email }, { guard: first.guard }).start(flow, "the week");
    const second = holdingGuard();
    const restarted = new Engine(store, { mock, email }, { guard: second.guard });
    assert.equal(restarted.resumeHolds(), 1);
    assert.deepEqual(second.waits, ["del-2"]);
    second.release("approved");
    await settle();
    assert.equal(restarted.view(waiting.id).state, "done");
  });
});
