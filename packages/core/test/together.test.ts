import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Connector } from "../src/connector.ts";
import { mock } from "../src/connectors/mock.ts";
import { Engine } from "../src/engine.ts";
import type { Guard, HandOff, Verdict } from "../src/guard.ts";
import { parseFlow, turnAt, turnsOf } from "../src/schema.ts";
import { Store } from "../src/store.ts";

const flow = parseFlow({
  name: "Week and weekend",
  assistants: [
    { id: "claw", name: "OpenClaw", connector: "mock", replies: { "*": "Three deadlines next week." } },
    { id: "hermes", name: "Hermes", connector: "mock", replies: { "*": "A day trip to Nandi Hills." } },
    { id: "hud", name: "Hud", connector: "mock" },
  ],
  steps: [
    {
      id: "both",
      type: "together",
      steps: [
        { id: "work", agent: "claw", ask: "Work: {{input}}" },
        { id: "home", agent: "hermes", ask: "Home: {{input}}" },
      ],
    },
    { id: "wrap", type: "agent", agent: "hud", ask: "{{work.text}} | {{home.text}}" },
  ],
});

/** Waits for something to come true while a run carries on in the background. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 400; tries += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const lines = (store: Store, runId: string) => store.logOf(runId).map((line) => `${line.stepId}:${line.kind}`);

describe("a together step", () => {
  it("asks every one at once, and goes on once all have answered, each answer under its own name", async () => {
    const asked: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: Connector = {
      async send(request) {
        asked.push(request.assistant.id);
        if (request.assistant.id !== "hud") await gate;
        return mock.send(request);
      },
    };
    const store = new Store();
    const runId = new Engine(store, { mock: slow }).launch(flow, "next week");
    await until(() => asked.length === 2, "both to be asked");
    assert.deepEqual(asked.toSorted(), ["claw", "hermes"], "the second was asked before the first answered");
    assert.equal(store.run(runId)?.state, "running");
    assert.equal(store.run(runId)?.at, "both", "the run says which step it's on from the start");
    release();
    await until(() => store.run(runId)?.state === "done", "the run to finish");
    const { steps } = store.run(runId)!.context;
    assert.equal(steps.work?.text, "Three deadlines next week.");
    assert.equal(steps.home?.text, "A day trip to Nandi Hills.");
    assert.equal(steps.both?.text, "OpenClaw:\nThree deadlines next week.\n\nHermes:\nA day trip to Nandi Hills.");
    assert.equal(steps.wrap?.text, "(Hud would answer: Three deadlines next week. | A day trip to Nandi Hills.)");
    assert.deepEqual(lines(store, runId).slice(0, 2).toSorted(), ["home:asked", "work:asked"]);
    assert.deepEqual(lines(store, runId).slice(-2), ["wrap:asked", "wrap:answered"]);
  });

  it("carries on without an optional one that can't answer", async () => {
    const offline: Connector = {
      async send(request) {
        if (request.assistant.id === "claw") throw new Error("fetch failed");
        return mock.send(request);
      },
    };
    const optional = parseFlow({ ...flow, steps: flow.steps.map((step) => (step.type === "together" ? { ...step, steps: step.steps.map((member) => ({ ...member, optional: true })) } : step)) });
    const store = new Store();
    const view = await new Engine(store, { mock: offline }).start(optional, "x");
    assert.equal(view.state, "done");
    assert.equal(view.context.steps.work?.text, "OpenClaw couldn't help this time (fetch failed).");
    assert.equal(view.context.steps.home?.text, "A day trip to Nandi Hills.");
    assert.ok(lines(store, view.id).includes("work:skipped"));
  });

  it("fails at the together step when one that's needed can't answer, says which, and runs them all again on a retry", async () => {
    let down = true;
    const flaky: Connector = {
      async send(request) {
        if (down && request.assistant.id === "claw") throw new Error("fetch failed");
        return mock.send(request);
      },
    };
    const store = new Store();
    const engine = new Engine(store, { mock: flaky });
    const failed = await engine.start(flow, "x");
    assert.equal(failed.state, "failed");
    assert.equal(failed.at, "both");
    assert.equal(failed.error, "OpenClaw couldn't do its part: fetch failed");
    assert.ok(lines(store, failed.id).includes("work:failed"), "the run page shows who failed");
    assert.ok(lines(store, failed.id).includes("home:answered"), "the other finished all the same");
    down = false;
    engine.retry(failed.id);
    await until(() => store.run(failed.id)?.state === "done", "the retried run to finish");
    assert.equal(store.run(failed.id)?.context.steps.work?.text, "Three deadlines next week.");
  });

  it("waits for your yes when a guard holds one, then asks them all, without asking you again", async () => {
    const checked: string[] = [];
    const guard: Guard = {
      name: "Fake",
      async check({ assistant }: HandOff): Promise<Verdict> {
        checked.push(assistant.id);
        return assistant.id === "hermes" ? { action: "hold", reason: "hermes needs a yes" } : { action: "allow", reason: "fine" };
      },
      async report() {},
      async finish() {},
    };
    const store = new Store();
    const engine = new Engine(store, { mock }, { guard });
    const waiting = await engine.start(flow, "x");
    assert.equal(waiting.state, "waiting");
    assert.equal(waiting.at, "both");
    assert.match(waiting.waiting?.message ?? "", /hermes/);
    assert.equal(store.approval(waiting.waiting!.id)?.stepId, "home");
    const done = await engine.decide(waiting.waiting!.id, true);
    assert.equal(done.state, "done");
    assert.deepEqual(checked, ["claw", "hermes", "claw", "hud"], "hermes isn't held again after your yes");
    assert.deepEqual(lines(store, done.id).filter((line) => line.endsWith(":asked")).toSorted(), ["home:asked", "work:asked", "wrap:asked"]);

    const declined = await engine.decide((await engine.start(flow, "y")).waiting!.id, false);
    assert.equal(declined.state, "declined");
  });
});

describe("a together step in a flow file", () => {
  it("lists its members as turns, in order", () => {
    assert.deepEqual(turnsOf(flow).map((turn) => [turn.id, turn.agent, turn.group ?? null]), [["work", "claw", "both"], ["home", "hermes", "both"], ["wrap", "hud", null]]);
    assert.equal(turnAt(flow, "home")?.group, "both");
    assert.equal(turnAt(flow, "both"), null, "the together step itself asks no one");
  });

  it("is checked like the rest: names unique, assistants known, nothing jumps into the middle of it", () => {
    const base = { name: "x", assistants: [{ id: "a", connector: "mock" }] };
    const two = [
      { id: "m1", agent: "a", ask: "one" },
      { id: "m2", agent: "a", ask: "two" },
    ];
    assert.throws(() => parseFlow({ ...base, steps: [{ id: "g", type: "together", steps: two }, { id: "m1", type: "agent", agent: "a", ask: "x" }] }), /two steps are called "m1"/);
    assert.throws(() => parseFlow({ ...base, steps: [{ id: "g", type: "together", steps: [...two, { id: "m3", agent: "ghost", ask: "x" }] }] }), /asks "ghost"/);
    assert.throws(() => parseFlow({ ...base, steps: [{ id: "first", type: "agent", agent: "a", ask: "x", next: "m2" }, { id: "g", type: "together", steps: two }] }), /goes to "m2", which isn't a step/);
    assert.throws(() => parseFlow({ ...base, steps: [{ id: "g", type: "together", steps: two.slice(0, 1) }] }), /steps/);
    assert.doesNotThrow(() => parseFlow({ ...base, steps: [{ id: "g", type: "together", steps: two, next: "end" }] }));
  });
});
