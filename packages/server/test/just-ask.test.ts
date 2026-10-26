import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Engine, mock, parseFlow, Router, Store } from "@huddle/core";
import { Asker, type Choices, type Planner, planFrom, planner, teamFlow } from "../src/just-ask.ts";

const { assistants } = parseFlow({
  name: "Mine",
  assistants: [
    { id: "claw", name: "OpenClaw", connector: "mock", memory: ["work"], description: "Work: tasks, deadlines, messages to the team.", replies: { "*": "Three deadlines." } },
    { id: "hermes", name: "Hermes", connector: "mock", memory: ["home"], description: "Research and home.", replies: { "*": "Groceries on Saturday." } },
  ],
  steps: [{ id: "a", type: "agent", agent: "claw", ask: "x" }],
});
const CHOICES: Choices = { flows: [{ id: "flow_week", name: "Plan my week", description: "OpenClaw, then Hermes." }], assistants };
const SAID = "Plan my week and tell the team what's due";

describe("Just ask", () => {
  it("makes a team's plan into a flow: each part sees what was asked and what came before, with your OK where the plan put it", () => {
    const flow = teamFlow(SAID, [{ assistant: "claw", ask: "List my work for next week." }, { approve: "Send this to your team?" }, { assistant: "hermes", ask: "Fit in what's on at home." }, { approve: "Anything else?" }], assistants);
    assert.deepEqual(
      flow.steps.map((step) => [step.id, step.type]),
      [
        ["step1", "agent"],
        ["ok2", "approval"],
        ["step3", "agent"],
      ],
      "a question with nothing after it is dropped",
    );
    const [first, ok, second] = flow.steps as unknown as [{ ask: string }, { message: string }, { ask: string }];
    assert.equal(first.ask, "List my work for next week. Do only this part: the rest of the team does the rest.\n\nWhat the person asked: {{input}}");
    assert.equal(ok.message, "Send this to your team?\n\n{{step1.text}}", "you see what you're saying yes to");
    assert.match(second.ask, /What OpenClaw came back with:\n\{\{step1\.text\}\}\n\n/);
    assert.match(second.ask, /You're the last of the team.*what OpenClaw came back with \(if they need something from the person, say what\), then your part\.$/, "the last speaks for the team");
    assert.equal(flow.trigger.type, "manual");
    assert.deepEqual(flow.assistants, assistants, "your assistants exactly as saved");
  });

  it("refuses a plan that names an assistant you don't have, gives nobody anything, or runs too long", () => {
    assert.throws(() => teamFlow(SAID, [{ assistant: "zeroclaw", ask: "Do it." }], assistants), /don't have: "zeroclaw"/);
    assert.throws(() => teamFlow(SAID, [{ approve: "OK?" }], assistants), /no assistant anything to do/);
    const five = Array.from({ length: 5 }, () => ({ assistant: "claw", ask: "Again." }));
    assert.throws(() => teamFlow(SAID, five, assistants), /5 turns/);
  });

  it("reads the model's answer only over what you have", () => {
    assert.deepEqual(planFrom({ use: "flow", id: "flow_week", say: "Planning your week." }, SAID, CHOICES), { use: "flow", flowId: "flow_week", say: "Planning your week." });
    assert.deepEqual(planFrom({ use: "one", id: "hermes", say: "ignored" }, "Weather?", CHOICES), { use: "one", assistant: "hermes", say: "" });
    // A team of one with nothing to approve is one assistant.
    assert.deepEqual(planFrom({ use: "team", say: "x", steps: [{ assistant: "claw", ask: "Do it." }] }, SAID, CHOICES), { use: "one", assistant: "claw", say: "" });
    const team = planFrom({ use: "team", say: "OpenClaw, then Hermes.", steps: [{ assistant: "claw", ask: "Work." }, { junk: true }, { assistant: "hermes", ask: "Home." }] }, SAID, CHOICES);
    assert.equal(team.use, "team");
    assert.equal(team.use === "team" ? team.flow.steps.length : 0, 2, "parts that aren't a job or a question are left out");
    assert.throws(() => planFrom({ use: "flow", id: "flow_made_up" }, SAID, CHOICES), /doesn't fit/);
    assert.throws(() => planFrom({ use: "one", id: "zeroclaw" }, SAID, CHOICES), /doesn't fit/);
    assert.throws(() => planFrom("no", SAID, CHOICES), /didn't answer with a plan/);
  });

  it("asks the model once, without thinking, with your flows and assistants, and keeps the key out of errors", async () => {
    let body: { model?: string; messages?: { role: string; content: string }[]; chat_template_kwargs?: unknown } = {};
    const answers = [JSON.stringify({ choices: [{ message: { content: '```json\n{"use": "team", "say": "OpenClaw, then Hermes.", "steps": [{"assistant": "claw", "ask": "Work."}, {"assistant": "hermes", "ask": "Home."}]}\n```' } }] })];
    const fetcher = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      const next = answers.shift();
      return next ? new Response(next) : new Response(JSON.stringify({ error: { message: "bad key sk-secret" } }), { status: 401 });
    }) as typeof fetch;
    const plan = await planner({ url: "https://api.tokenfactory.nebius.com/v1", model: "nvidia/nemotron-3-super-120b-a12b", key: "sk-secret", fetcher })(SAID, CHOICES);
    assert.equal(plan.use, "team");
    assert.equal(plan.say, "OpenClaw, then Hermes.");
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    const system = body.messages?.[0]?.content ?? "";
    assert.match(system, /- flow_week: Plan my week: OpenClaw, then Hermes\./);
    assert.match(system, /- claw: OpenClaw \(mock\): Work: tasks, deadlines, messages to the team\./);
    assert.equal(body.messages?.[1]?.content, SAID);
    await assert.rejects(planner({ url: "https://api.tokenfactory.nebius.com/v1", model: "m", key: "sk-secret", fetcher })(SAID, CHOICES), (error: Error) => error.message === "The model said: bad key [key]");
  });

  it("ends a team with Hud saying what each came back with, and lets a member who can't be reached be skipped", () => {
    const parts = [{ assistant: "claw", ask: "Work." }, { assistant: "hermes", ask: "Home." }] as const;
    const flow = teamFlow(SAID, parts, assistants, HUD);
    assert.deepEqual(flow.steps.map((step) => [step.id, step.type === "agent" ? step.agent : step.type, step.type === "agent" ? (step.optional ?? false) : null]), [
      ["step1", "claw", true],
      ["step2", "hermes", true],
      ["wrap", "hud", false],
    ]);
    const wrap = flow.steps.at(-1) as { ask: string };
    assert.match(wrap.ask, /^You're Hud/);
    assert.match(wrap.ask, /OpenClaw came back with:\n\{\{step1\.text\}\}/);
    assert.match(wrap.ask, /Hermes came back with:\n\{\{step2\.text\}\}/);
    assert.doesNotMatch((flow.steps[1] as { ask: string }).ask, /last of the team/, "Hud speaks for the team, not the last member");
    assert.deepEqual(flow.assistants.map((assistant) => assistant.id), ["claw", "hermes", "hud"]);
    // One of yours already called "hud" keeps its id; Hud takes another.
    const yoursHud = parseFlow({ name: "x", assistants: [{ id: "hud", connector: "mock" }], steps: [{ id: "a", type: "agent", agent: "hud", ask: "x" }] }).assistants;
    const both = teamFlow(SAID, [{ assistant: "claw", ask: "Work." }, { assistant: "hud", ask: "Yours." }], [...assistants, ...yoursHud], HUD);
    assert.deepEqual(both.assistants.map((assistant) => assistant.id), ["claw", "hud", "huddle-hud"]);
    assert.equal((both.steps.at(-1) as { agent: string }).agent, "huddle-hud");
    // A single assistant's turn isn't a team: no Hud, nothing optional.
    const alone = teamFlow(SAID, [{ assistant: "claw", ask: "Work." }, { approve: "OK?" }], assistants, HUD);
    assert.deepEqual(alone.steps.map((step) => step.id), ["step1"]);
  });

  it("has parts that don't need each other's answers work at the same time, and Hud hears from all of them", () => {
    const plan = planFrom(
      { use: "team", say: "OpenClaw pulls your week while Hermes finds Saturday.", steps: [{ together: [{ assistant: "claw", ask: "Work." }, { assistant: "hermes", ask: "Home." }] }, { approve: "Send it?" }, { assistant: "claw", ask: "Send it to the team." }] },
      SAID,
      CHOICES,
      HUD,
    );
    assert.equal(plan.use, "team");
    if (plan.use !== "team") return;
    const [together, ok, send, wrap] = plan.flow.steps;
    assert.equal(together?.type, "together");
    if (together?.type !== "together") return;
    assert.deepEqual(together.steps.map((member) => [member.id, member.agent, member.optional]), [["step1a", "claw", true], ["step1b", "hermes", true]]);
    assert.doesNotMatch(together.steps[1]!.ask, /came back with/, "neither sees the other's answer");
    assert.equal(ok?.type === "approval" ? ok.message : "", "Send it?\n\n{{together1.text}}", "the question shows what both came back with");
    assert.match(send?.type === "agent" ? send.ask : "", /OpenClaw came back with:\n\{\{step1a\.text\}\}[\s\S]*Hermes came back with:\n\{\{step1b\.text\}\}/);
    assert.match(wrap?.type === "agent" ? wrap.ask : "", /Hermes came back with:\n\{\{step1b\.text\}\}/);
    // Without Hud to sum up, they go in order, so the last one can speak for the team.
    const inOrder = teamFlow(SAID, [{ together: [{ assistant: "claw", ask: "Work." }, { assistant: "hermes", ask: "Home." }] }], assistants);
    assert.deepEqual(inOrder.steps.map((step) => [step.id, step.type]), [["step1", "agent"], ["step2", "agent"]]);
    // A "together" of one is just a part; past four parts in all, it's too long for the button.
    const single = planFrom({ use: "team", steps: [{ together: [{ assistant: "claw", ask: "Work." }, { assistant: "ghost" }] }] }, SAID, CHOICES, HUD);
    assert.deepEqual(single, { use: "one", assistant: "claw", say: "" });
    const parts = Array.from({ length: 5 }, () => ({ assistant: "claw", ask: "x" }));
    assert.throws(() => planFrom({ use: "team", steps: [{ together: parts }] }, SAID, CHOICES, HUD), /at most 4/);
  });
});

const HUD = parseFlow({ name: "h", assistants: [{ id: "hud", name: "Hud", connector: "mock", replies: { "*": "OpenClaw has three deadlines; Hermes says groceries on Saturday." } }], steps: [{ id: "a", type: "agent", agent: "hud", ask: "x" }] }).assistants[0]!;

describe("Just ask, wherever it's asked from", () => {
  const settle = async (store: Store, runId: string) => {
    for (let tries = 0; store.run(runId)?.state === "running" && tries < 200; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  const setup = (plan: Planner) => {
    const store = new Store();
    const engine = new Engine(store, { mock });
    store.saveAssistants(assistants);
    return { store, engine, asker: new Asker(store, engine, new Router(store, engine, null), plan) };
  };
  const BY = { name: "Canvas", tier: "owner", via: "canvas" } as const;

  it("starts a team, logs the plan on the run, and keeps the team as a flow on the button, once", async () => {
    const { store, asker } = setup(async (said, choices) => ({ use: "team", say: "OpenClaw, then Hermes.", flow: teamFlow(said, [{ assistant: "claw", ask: "Work." }, { assistant: "hermes", ask: "Home." }], choices.assistants, HUD) }));
    const asked = await asker.ask(`  ${SAID}  `, BY, { note: "SAY IT ALOUD" });
    assert.deepEqual(asked.plan.team.map((who) => who.name), ["OpenClaw", "Hermes", "Hud"]);
    assert.equal(asked.answer, null);
    assert.equal(asked.run?.assistant?.id, "claw");
    const runId = asked.run!.runId;
    await settle(store, runId);
    const run = store.run(runId)!;
    assert.equal(run.state, "done");
    assert.equal(run.context.input, SAID);
    assert.equal(run.context.steps.wrap?.text, "OpenClaw has three deadlines; Hermes says groceries on Saturday.");
    assert.ok((run.flow.steps.at(-1) as { ask: string }).ask.startsWith("SAY IT ALOUD\n\n"), "the note goes to the step whose answer is said");
    const planned = store.logOf(runId).find((line) => line.kind === "planned")?.detail as { use: string; say: string; team: string[]; flow: { steps: { ask: string }[] } };
    assert.deepEqual([planned.use, planned.say, planned.team], ["team", "OpenClaw, then Hermes.", ["claw", "hermes", "hud"]]);
    assert.ok(!planned.flow.steps.some((step) => step.ask.includes("SAY IT ALOUD")), "the plan as planned, without the note");

    const kept = asker.keepTeam(runId);
    assert.equal(kept.flow.name, "Plan my week and tell the team what's due");
    assert.deepEqual(kept.flow.trigger, { type: "button", input: SAID });
    assert.ok(!kept.flow.steps.some((step) => step.type === "agent" && step.ask.includes("SAY IT ALOUD")));
    assert.equal(asker.keepTeam(runId).id, kept.id, "kept once");
    assert.equal(store.flows().length, 1);
    assert.throws(() => asker.keepTeam("run_nothere"), /There's no run/);
  });

  it("runs a saved flow it picked, answers through one assistant, and with no plan lets the router pick", async () => {
    const week = parseFlow({ name: "Plan my week", trigger: { type: "manual" }, assistants, steps: [{ id: "w", type: "agent", agent: "claw", ask: "{{input}}" }] });
    const flowPicked = setup(async () => ({ use: "flow", flowId: "", say: "Planning your week." }));
    const saved = flowPicked.store.saveFlow(week);
    const viaFlow = await new Asker(flowPicked.store, flowPicked.engine, new Router(flowPicked.store, flowPicked.engine, null), async () => ({ use: "flow", flowId: saved.id, say: "Planning your week." })).ask(SAID, BY);
    assert.equal(viaFlow.run?.flow, "Plan my week");
    assert.equal(flowPicked.store.run(viaFlow.run!.runId)?.flowId, saved.id);
    assert.throws(() => flowPicked.asker.keepTeam(viaFlow.run!.runId), /Only a team/, "a saved flow isn't a team to keep");

    const one = await setup(async () => ({ use: "one", assistant: "hermes", say: "" })).asker.ask("What's on Saturday?", BY);
    assert.deepEqual([one.run, one.answer?.text, one.answer?.assistant.name, one.plan.use], [null, "Groceries on Saturday.", "Hermes", "one"]);

    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const unplanned = await setup(async () => {
        throw new Error("model down");
      }).asker.ask("Anything", BY);
      assert.equal(unplanned.answer?.assistant.name, "OpenClaw", "no judge: the first in your list");
    } finally {
      console.warn = warn;
    }
    await assert.rejects(setup(async () => ({ use: "one", assistant: "hermes", say: "" })).asker.ask("   ", BY), /Say what you need/);
  });
});
