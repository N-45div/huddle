import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluate } from "../src/condition.ts";
import { parseFlow } from "../src/schema.ts";
import { render, type RunContext } from "../src/template.ts";

const context: RunContext = {
  input: "Invoice from Northwind",
  steps: { read: { text: "{...}", data: { vendor: "Northwind", amount: 450, tags: ["hosting"] } } },
};

describe("templates", () => {
  it("fill in the input, an answer's text and its data, and leave what's missing empty", () => {
    assert.equal(render("{{input}} / {{read.data.vendor}} / {{ read.data.amount }}", context), "Invoice from Northwind / Northwind / 450");
    assert.equal(render("{{read}}", context), "{...}");
    assert.equal(render("[{{nope.data.x}}][{{read.data.nope}}]", context), "[][]");
    assert.equal(render("{{read.data.tags}}", context), '["hosting"]');
  });
});

describe("conditions", () => {
  it("compare numbers as numbers, money signs and commas included", () => {
    assert.equal(evaluate("{{read.data.amount}} > 200", context), true);
    assert.equal(evaluate("$1,200 >= 1200", context), true);
    assert.equal(evaluate("{{read.data.amount}} < 100", context), false);
  });

  it("compare text without caring about case, and look inside it", () => {
    assert.equal(evaluate("{{read.data.vendor}} == northwind", context), true);
    assert.equal(evaluate('{{read.data.vendor}} != "Contoso"', context), true);
    assert.equal(evaluate("{{input}} contains NORTHWIND", context), true);
  });

  it("refuse to order text, and never run anything as code", () => {
    assert.throws(() => evaluate("apples > pears", context), /must be numbers/);
    assert.throws(() => evaluate("process.exit(1)", context), /isn't a comparison/);
  });
});

describe("flow files", () => {
  const base = {
    name: "t",
    assistants: [{ id: "a", connector: "mock" }],
    steps: [{ id: "one", type: "agent", agent: "a", ask: "hi" }],
  };

  it("load with defaults filled in", () => {
    const flow = parseFlow(base);
    assert.deepEqual(flow.trigger, { type: "manual" });
    assert.deepEqual(flow.assistants[0]?.memory, []);
  });

  it("say plainly what's wrong: a missing step, an unknown assistant, a repeated id", () => {
    const broken = {
      ...base,
      steps: [
        { id: "one", type: "agent", agent: "ghost", ask: "hi", next: "nowhere" },
        { id: "one", type: "approval", message: "ok?" },
      ],
    };
    assert.throws(() => parseFlow(broken), (error: Error) => {
      assert.match(error.message, /"ghost", which isn't one of the flow's assistants/);
      assert.match(error.message, /goes to "nowhere", which isn't a step/);
      assert.match(error.message, /two steps are called "one"/);
      return true;
    });
  });

  it("keep keys out of flow files: an assistant names an environment variable instead", () => {
    assert.throws(() => parseFlow({ ...base, assistants: [{ id: "a", connector: "http", keyEnv: "sk_live_abc" }] }), /environment variable name/);
  });
});
