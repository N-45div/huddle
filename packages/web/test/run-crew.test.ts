import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Connector } from "../../core/src/connector.ts";
import { mock } from "../../core/src/connectors/mock.ts";
import { Engine } from "../../core/src/engine.ts";
import { parseFlow } from "../../core/src/schema.ts";
import { Store } from "../../core/src/store.ts";
import { crewOf, elapsed, modelName, nodesOf, plain } from "../src/run-crew.ts";

const PLAN = parseFlow({
  name: "Weekend plan",
  assistants: [
    { id: "planner", name: "Planner (Nemotron Ultra)", connector: "mock", model: "nvidia/Nemotron-3-Ultra-550b-a55b", replies: { "*": "Saturday: the palace, then Chamundi Hill." } },
    { id: "mailer", name: "Mailer", connector: "mock", replies: { "*": "Sent." } },
  ],
  steps: [
    { id: "plan", type: "agent", agent: "planner", ask: "Plan a weekend in Mysuru: {{input}}" },
    { id: "ok", type: "approval", message: "Send this plan? {{plan.text}}" },
    { id: "send", type: "agent", agent: "mailer", ask: "Send: {{plan.text}}" },
  ],
});

const detailOf = (store: Store, engine: Engine, runId: string) => ({ run: engine.view(runId), flow: store.run(runId)!.flow, log: store.logOf(runId) });

describe("who is on a run", () => {
  it("shows the flow at the top and each hand-off and approval under it, as they happen", async () => {
    const store = new Store();
    const engine = new Engine(store, { mock });
    const run = await engine.start(PLAN, "two of us, vegetarian");

    const waiting = crewOf(detailOf(store, engine, run.id));
    assert.equal(waiting.name, "Weekend plan");
    assert.equal(waiting.status, "needs-you");
    assert.equal(waiting.task, "two of us, vegetarian");
    assert.deepEqual(waiting.children.map((node) => [node.kind, node.name, node.status]), [["assistant", "Planner", "done"], ["you", "You", "needs-you"]]);
    assert.equal(waiting.children[0]!.by, "Nemotron 3 Ultra");
    assert.equal(waiting.children[0]!.task, "Plan a weekend in Mysuru: two of us, vegetarian");
    assert.equal(waiting.children[1]!.approvalId, run.waiting!.id, "the card can take your answer");

    await engine.decide(run.waiting!.id, true);
    const done = crewOf(detailOf(store, engine, run.id));
    assert.equal(done.status, "done");
    assert.deepEqual(done.children.map((node) => [node.name, node.status]), [["Planner", "done"], ["You", "done"], ["Mailer", "done"]]);
    assert.equal(done.children[2]!.by, "Stand-in", "no model: the connector's name");
    assert.equal(nodesOf(done).length, 4);
  });

  it("shows the step being worked on as running, from the run's very first step", async () => {
    let finish: (text: string) => void = () => undefined;
    const slow: Connector = { send: () => new Promise((resolve) => (finish = (text) => resolve({ text }))) };
    const flow = parseFlow({ name: "Slow", assistants: [{ id: "planner", name: "Planner", connector: "http", url: "http://planner.test" }], steps: [{ id: "plan", type: "agent", agent: "planner", ask: "Plan it" }] });
    const store = new Store();
    const engine = new Engine(store, { http: slow });
    const runId = engine.launch(flow, "");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const working = crewOf(detailOf(store, engine, runId));
    assert.equal(working.status, "running");
    assert.equal(working.children[0]!.status, "running");
    assert.equal(working.children[0]!.endedAt, null);
    finish("Planned.");
    for (let wait = 0; wait < 50 && store.run(runId)?.state !== "done"; wait++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(crewOf(detailOf(store, engine, runId)).children[0]!.status, "done");
  });

  it("keeps a failed try under the newest one, stopped, once the step is tried again", async () => {
    let calls = 0;
    const flaky: Connector = {
      async send() {
        calls += 1;
        if (calls === 1) throw new Error("2 of 14 checkout tests fail: coupon codes aren't applied");
        return { text: "All 14 pass." };
      },
    };
    const flow = parseFlow({ name: "Checkout", assistants: [{ id: "tester", name: "Tester", connector: "http", url: "http://tester.test" }], steps: [{ id: "test", type: "agent", agent: "tester", ask: "Run the checkout tests" }] });
    const store = new Store();
    const engine = new Engine(store, { http: flaky });
    const run = await engine.start(flow, "");

    const failed = crewOf(detailOf(store, engine, run.id));
    assert.equal(failed.status, "failed");
    assert.equal(failed.children[0]!.status, "failed");
    assert.match(failed.children[0]!.error ?? "", /coupon codes/);

    engine.retry(run.id);
    for (let wait = 0; wait < 50 && store.run(run.id)?.state !== "done"; wait++) await new Promise((resolve) => setTimeout(resolve, 5));
    const retried = crewOf(detailOf(store, engine, run.id));
    const tester = retried.children[0]!;
    assert.equal(tester.status, "done");
    assert.deepEqual(tester.children.map((node) => [node.status, node.error]), [["stopped", "2 of 14 checkout tests fail: coupon codes aren't applied"]]);
  });

  it("shows a team member the run went on without, with why, while the run itself is done", async () => {
    const down: Connector = {
      async send(request) {
        if (request.assistant.id === "claw") throw new Error("connect ECONNREFUSED 127.0.0.1:18789");
        return mock.send(request);
      },
    };
    const flow = parseFlow({
      name: "Just ask",
      assistants: [
        { id: "claw", name: "OpenClaw", connector: "mock" },
        { id: "hud", name: "Hud", connector: "mock", replies: { "*": "OpenClaw couldn't be reached." } },
      ],
      steps: [
        { id: "step1", type: "agent", agent: "claw", ask: "Work.", optional: true },
        { id: "wrap", type: "agent", agent: "hud", ask: "Say what came back: {{step1.text}}" },
      ],
    });
    const store = new Store();
    const engine = new Engine(store, { mock: down });
    const run = await engine.start(flow, "");
    const crew = crewOf(detailOf(store, engine, run.id));
    assert.equal(crew.status, "done");
    assert.deepEqual(crew.children.map((node) => [node.name, node.status]), [["OpenClaw", "failed"], ["Hud", "done"]]);
    assert.equal(crew.children[0]!.error, "Couldn't help, so the team went on without it: connect ECONNREFUSED 127.0.0.1:18789");
  });

  it("shows everyone at a together step as working at once, and each done as it answers", async () => {
    const waits = new Map<string, (text: string) => void>();
    const held: Connector = { send: (request) => new Promise((resolve) => waits.set(request.assistant.id, (text) => resolve({ text }))) };
    const flow = parseFlow({
      name: "Just ask",
      assistants: [
        { id: "claw", name: "OpenClaw", connector: "http", url: "http://claw.test" },
        { id: "hermes", name: "Hermes", connector: "http", url: "http://hermes.test" },
      ],
      steps: [
        {
          id: "both",
          type: "together",
          steps: [
            { id: "work", agent: "claw", ask: "Work." },
            { id: "home", agent: "hermes", ask: "Home." },
          ],
        },
      ],
    });
    const store = new Store();
    const engine = new Engine(store, { http: held });
    const runId = engine.launch(flow, "");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(crewOf(detailOf(store, engine, runId)).children.map((node) => [node.name, node.status]), [["OpenClaw", "running"], ["Hermes", "running"]]);
    waits.get("hermes")!("Saturday: Nandi Hills.");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(crewOf(detailOf(store, engine, runId)).children.map((node) => [node.name, node.status]), [["OpenClaw", "running"], ["Hermes", "done"]]);
    waits.get("claw")!("Three deadlines.");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const done = crewOf(detailOf(store, engine, runId));
    assert.equal(done.status, "done");
    assert.deepEqual(done.children.map((node) => [node.name, node.status]), [["OpenClaw", "done"], ["Hermes", "done"]]);
  });

  it("names models the way people say them, and times the way a card shows them", () => {
    assert.equal(modelName("nvidia/nemotron-3-super-120b-a12b"), "Nemotron 3 Super");
    assert.equal(modelName("nvidia/Nemotron-3_5-Lightning"), "Nemotron 3.5 Lightning");
    assert.equal(modelName("nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"), "Nemotron 3 Nano");
    assert.equal(modelName("nvidia/Nemotron-3.5-Super-VL"), "Nemotron 3.5 Super VL");
    assert.equal(modelName("qwen3"), "Qwen3");
    assert.equal(plain("**Saturday (Day 1)** | Time | Activity |\n|---|---|\n| 9am | Palace |"), "Saturday (Day 1) · Time · Activity · 9am · Palace");
    assert.equal(elapsed("2026-10-20T10:00:00Z", "2026-10-20T10:00:45Z"), "45s");
    assert.equal(elapsed("2026-10-20T10:00:00Z", "2026-10-20T10:01:09Z"), "1m 09s");
    assert.equal(elapsed("2026-10-20T10:00:00Z", "2026-10-20T12:05:00Z"), "2h 05m");
  });
});
