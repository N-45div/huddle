import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Assistant, Engine, mock, Router, Store } from "@huddle/core";
import type { AskReply, FlowView, Info } from "../src/api-types.ts";
import { createApp } from "../src/app.ts";
import { Asker, type Planner, teamFlow } from "../src/just-ask.ts";

const TOKEN = "huddle-token-0123456789";

function setup(withAsker = true) {
  const store = new Store();
  const engine = new Engine(store, { mock });
  const router = new Router(store, engine);
  store.saveAssistants([
    Assistant.parse({ id: "claw", name: "OpenClaw", connector: "mock", replies: { "*": "Three deadlines." } }),
    Assistant.parse({ id: "hermes", name: "Hermes", connector: "mock", replies: { "*": "Groceries on Saturday." } }),
  ]);
  const planner: Planner = async (said, choices) =>
    said.includes("week") ? { use: "team", say: "OpenClaw, then Hermes.", flow: teamFlow(said, [{ assistant: "claw", ask: "Work." }, { assistant: "hermes", ask: "Home." }], choices.assistants) } : { use: "one", assistant: "hermes", say: "" };
  const app = createApp({ store, engine, version: "test", publicUrl: "http://huddle.test", token: TOKEN, router, ...(withAsker ? { asker: new Asker(store, engine, router, planner) } : {}) });
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { store, app, post };
}

const settle = async (store: Store, runId: string) => {
  for (let tries = 0; store.run(runId)?.state === "running" && tries < 200; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

describe("Just ask over the API", () => {
  it("plans a sentence and starts the team, answers one assistant's question, and says when it's off", async () => {
    const { store, app, post } = setup();
    assert.equal(((await (await app.request("/api/info")).json()) as Info).justAsk, true);

    const team = (await (await post("/api/ask", { text: "Plan my week" })).json()) as AskReply;
    assert.deepEqual([team.plan.use, team.plan.say, team.plan.team.map((who) => who.name)], ["team", "OpenClaw, then Hermes.", ["OpenClaw", "Hermes"]]);
    assert.equal(team.answer, null);
    await settle(store, team.run!.runId);
    assert.equal(store.run(team.run!.runId)?.state, "done");
    assert.deepEqual(store.logOf(team.run!.runId)[0]?.detail, { name: "Canvas", tier: "owner", via: "canvas" });

    const one = (await (await post("/api/ask", { text: "What's on Saturday?" })).json()) as AskReply;
    assert.deepEqual([one.run, one.answer?.text, one.answer?.assistant.name], [null, "Groceries on Saturday.", "Hermes"]);

    assert.equal((await post("/api/ask", { text: " " })).status, 400);
    assert.equal((await app.request("/api/ask", { method: "POST", body: "{}" })).status, 401, "behind the token like the rest");
    const off = setup(false);
    assert.equal(((await (await off.app.request("/api/info")).json()) as Info).justAsk, false);
    assert.equal((await off.post("/api/ask", { text: "Plan my week" })).status, 501);
  });

  it("keeps a team it made as a flow on the button, once, and nothing else", async () => {
    const { store, post } = setup();
    const team = (await (await post("/api/ask", { text: "Plan my week" })).json()) as AskReply;
    await settle(store, team.run!.runId);
    const kept = await post(`/api/runs/${team.run!.runId}/keep`, { name: "My week" });
    assert.equal(kept.status, 201);
    const view = (await kept.json()) as FlowView;
    assert.deepEqual([view.flow.name, view.flow.trigger], ["My week", { type: "button", input: "Plan my week" }]);
    assert.equal(((await (await post(`/api/runs/${team.run!.runId}/keep`, {})).json()) as FlowView).id, view.id, "kept once");

    const one = (await (await post("/api/ask", { text: "What's on Saturday?" })).json()) as AskReply;
    const refused = await post(`/api/runs/${one.answer!.runId}/keep`, {});
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { error: string }).error, /Only a team/);
  });
});
