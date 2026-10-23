import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFlow } from "@huddle/core";
import { type Choices, planFrom, planner, teamFlow } from "../src/just-ask.ts";

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
});
