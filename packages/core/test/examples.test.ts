import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { Connector } from "../src/connector.ts";
import { Engine } from "../src/engine.ts";
import { parseFlow } from "../src/schema.ts";
import { Store } from "../src/store.ts";

/**
 * Every flow in examples/ runs end to end: each assistant is a stand-in that answers with JSON the flows'
 * conditions and templates read, and every approval is answered yes, so the whole path is walked.
 */

const folder = new URL("../../../examples/", import.meta.url);
const files = readdirSync(folder).filter((name) => name.endsWith(".json"));
const answer = JSON.stringify({ important: true, why: "it's from your landlord", summary: "Rent goes up in March.", focus: ["ship v0.2.0", "call mum", "gym"], options: ["A", "B"], pick: "A", items: ["standup"], total: 450, vendor: "Northwind", amount: 450 });

describe("the example flows", () => {
  it("are all here", () => {
    assert.ok(files.length >= 5, files.join(", "));
  });

  for (const file of files) {
    it(`${file} runs end to end`, async () => {
      const flow = parseFlow(JSON.parse(readFileSync(new URL(file, folder), "utf8")));
      const asked: string[] = [];
      const standIn: Connector = {
        async send({ assistant, ask }) {
          asked.push(`${assistant.id}: ${ask.slice(0, 40)}`);
          assert.ok(!/\{\{/.test(ask), `${assistant.id} was asked with an unfilled template: ${ask}`);
          return { text: answer, data: JSON.parse(answer) };
        },
      };
      const connectors = Object.fromEntries(flow.assistants.map((assistant) => [assistant.connector, standIn]));
      const store = new Store();
      const engine = new Engine(store, connectors);
      let view = await engine.start(flow, "Should I take the job in Pune?");
      for (let guard = 0; view.state === "waiting" && guard < 10; guard++) {
        view = await engine.decide(view.waiting!.id, true);
      }
      assert.equal(view.state, "done", `${file}: ${view.error ?? view.state}`);
      assert.ok(asked.length > 0);
    });
  }
});
