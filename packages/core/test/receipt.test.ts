import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mock } from "../src/connectors/mock.ts";
import { Engine } from "../src/engine.ts";
import type { FactCheck } from "../src/factcheck.ts";
import { receiptOf } from "../src/receipt.ts";
import { parseFlow } from "../src/schema.ts";
import { Store } from "../src/store.ts";
import { TOKEN_FACTORY_URL } from "../src/tokenfactory.ts";

describe("a run's privacy receipt", () => {
  it("says where each request went, with which notes, and what a fact check sent to the web", async () => {
    const store = new Store();
    const home = store.remember("home", "Lives in Bengaluru, prefers trains.");
    store.remember("money", "Salary is credited on the 1st.");
    const flow = parseFlow({
      name: "Weekend",
      assistants: [
        { id: "planner", name: "Planner", connector: "nebius", model: "nvidia/Nemotron-3-Ultra-550b-a55b", memory: ["home"] },
        { id: "web", connector: "tavily", memory: ["home"] },
        { id: "local", connector: "ollama", model: "qwen3", memory: ["home", "money"] },
      ],
      steps: [
        { id: "plan", type: "agent", agent: "planner", ask: "Plan my weekend" },
        { id: "look", type: "agent", agent: "web", ask: "Mysore Palace hours" },
        { id: "sum", type: "agent", agent: "local", ask: "Can I afford it?" },
        { id: "ok", type: "approval", message: "Go?", check: true },
      ],
    });
    // Every assistant answers from a stand-in; the receipt only reads what the run logged.
    const standIn = { send: mock.send };
    const checks: FactCheck = { facts: [{ claim: "Mysore Palace opens at 10:00", verdict: "supported", note: "", source: null }], checkedBy: "m", costUsd: 0, sentTo: ["api.tokenfactory.nebius.com", "api.tavily.com"] };
    const engine = new Engine(store, { nebius: standIn, tavily: standIn, ollama: standIn }, { checker: async () => checks });
    const run = await engine.start({ ...flow, assistants: flow.assistants.map((assistant) => ({ ...assistant, replies: { "*": "ok" } })) }, "go");

    const receipt = receiptOf(flow, store.logOf(run.id), store.notes());
    const [plan, look, sum] = receipt.disclosures;
    assert.deepEqual(plan?.to, { label: "Nebius Token Factory (api.tokenfactory.nebius.com)", host: new URL(TOKEN_FACTORY_URL).hostname, local: false });
    assert.deepEqual(plan?.notes.map((note) => [note.slice, note.note]), [["home", "Lives in Bengaluru, prefers trains."]]);
    assert.equal(plan?.chars, "Plan my weekend".length);
    assert.deepEqual(look?.notes, [], "a web search never gets your notes");
    assert.deepEqual(sum?.to, { label: "Ollama on this machine", host: null, local: true });
    assert.equal(sum?.notes.length, 2);
    assert.deepEqual(receipt.searches, [{ stepId: "ok", queries: ["Mysore Palace opens at 10:00"], sentTo: ["api.tokenfactory.nebius.com", "api.tavily.com"] }]);
    assert.deepEqual(receipt.services, ["api.tavily.com", "api.tokenfactory.nebius.com"]);

    // A note forgotten since still shows it was sent, without its words.
    store.forget(home.id);
    assert.deepEqual(receiptOf(flow, store.logOf(run.id), store.notes()).disclosures[0]?.notes, [{ id: home.id, slice: null, note: null }]);
  });
});
