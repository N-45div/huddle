import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultContent, flowToGraph, graphToFlow, idsInUse, isIncomplete, isStepNode, retargetContent } from "../src/editor/graph.ts";
import type { Flow } from "../src/types.ts";

const flow: Flow = {
  name: "Week and weekend",
  trigger: { type: "manual" },
  assistants: [
    { id: "claw", name: "OpenClaw", connector: "openclaw", memory: ["work"] },
    { id: "hermes", name: "Hermes", connector: "hermes", memory: ["home"] },
    { id: "hud", name: "Hud", connector: "nebius", memory: [] },
  ],
  steps: [
    {
      id: "both",
      type: "together",
      steps: [
        { id: "work", agent: "claw", ask: "Work: {{input}}" },
        { id: "home", agent: "hermes", ask: "Home: {{input}}", optional: true },
      ],
      next: "wrap",
    },
    { id: "wrap", type: "agent", agent: "hud", ask: "{{work.text}} | {{home.text}}", next: "end" },
  ],
};

describe("a together step on the canvas", () => {
  it("is one node, and saves back to the same step with its members and its way out", () => {
    const graph = flowToGraph(flow);
    const steps = graph.nodes.filter(isStepNode);
    assert.deepEqual(steps.map((node) => node.id), ["both", "wrap"]);
    assert.deepEqual(graph.edges.map((edge) => `${edge.source}->${edge.target}`).sort(), ["__start->both", "both->wrap"]);
    const saved = graphToFlow(graph.meta, graph.nodes, graph.edges);
    assert.deepEqual(saved.steps, flow.steps);
  });

  it("knows every id in use, members' too, and fills a new one in with names of its own", () => {
    const graph = flowToGraph(flow);
    assert.deepEqual([...idsInUse(graph.nodes)].filter((id) => id !== "__start").sort(), ["both", "home", "work", "wrap"]);
    const fresh = defaultContent("together", flow.assistants, new Set(["part", "work"]));
    assert.equal(fresh.type, "together");
    if (fresh.type !== "together") return;
    assert.deepEqual(fresh.members.map((member) => [member.id, member.agent]), [["part-2", "claw"], ["part-3", "hermes"]]);
    assert.ok(isIncomplete(fresh, flow.assistants), "no asks yet");
  });

  it("follows a rename into its members' asks", () => {
    const together = flowToGraph(flow).nodes.filter(isStepNode)[0]!.data;
    const renamed = retargetContent(together, "input", "request");
    assert.equal(renamed.type, "together");
    if (renamed.type !== "together") return;
    assert.deepEqual(renamed.members.map((member) => member.ask), ["Work: {{request}}", "Home: {{request}}"]);
  });
});
