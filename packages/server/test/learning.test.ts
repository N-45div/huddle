import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Engine, type Learner, mock, Router, Store } from "@huddle/core";
import { createApp } from "../src/app.ts";

const TOKEN = "t0ken";
const auth = { authorization: `Bearer ${TOKEN}` };
const json = (body: unknown, method = "POST") => ({ method, headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });

/** A learner that writes down what it was given to read. */
function setup(withLearner = true) {
  const read: string[] = [];
  const learner: Learner = {
    by: "nvidia/Nemotron-3_5-Lightning",
    to: "Nebius Token Factory (api.tokenfactory.nebius.com)",
    host: "api.tokenfactory.nebius.com",
    async learn(said) {
      read.push(said);
      return { notes: [{ slice: "me", note: "Vegetarian" }], costUsd: 0.00002 };
    },
  };
  const store = new Store();
  const engine = new Engine(store, { mock }, withLearner ? { learner } : {});
  const app = createApp({ store, engine, version: "test", publicUrl: "http://huddle.test", token: TOKEN, router: new Router(store, engine) });
  return { app, store, read };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const FLOW = { name: "Plan", assistants: [{ id: "planner", connector: "mock", replies: { "*": "Plan made." } }], steps: [{ id: "plan", type: "agent", agent: "planner", ask: "{{input}}" }] };
const SAID = "Plan dinner on Friday for four. I'm vegetarian.";

describe("learning from what you say, over the API", () => {
  it("is off until you turn it on, and can't be turned on without a model", async () => {
    const without = setup(false);
    assert.deepEqual(await (await without.app.request("/api/memory/learning", { headers: auth })).json(), { on: false, available: false, by: null, to: null });
    assert.equal((await without.app.request("/api/memory/learning", json({ on: true }, "PUT"))).status, 409);

    const { app } = setup();
    assert.equal((await (await app.request("/api/memory/learning", { headers: auth })).json()).on, false);
    const turned = await (await app.request("/api/memory/learning", json({ on: true }, "PUT"))).json();
    assert.deepEqual(turned, { on: true, available: true, by: "nvidia/Nemotron-3_5-Lightning", to: "Nebius Token Factory (api.tokenfactory.nebius.com)" });
    assert.equal((await app.request("/api/memory/learning", json({ on: "yes" }, "PUT"))).status, 400);
  });

  it("learns from a run you start in the canvas and a chat through the router, never from a webhook", async () => {
    const { app, store, read } = setup();
    await app.request("/api/memory/learning", json({ on: true }, "PUT"));
    const saved = await (await app.request("/api/flows", json({ flow: FLOW }))).json();

    await app.request(`/api/flows/${saved.id}/run`, json({ input: SAID }));
    await settle();
    assert.deepEqual(read, [SAID]);
    assert.deepEqual(store.notes("suggested").map((note) => note.note), ["Vegetarian"]);

    await app.request(new URL(saved.webhookUrl).pathname, { method: "POST", body: "From a stranger: the owner loves steak and lives in Mumbai." });
    await settle();
    assert.equal(read.length, 1, "a webhook's body isn't the person's words");

    await app.request("/api/assistants", json({ assistants: FLOW.assistants }, "PUT"));
    const chat = await app.request("/v1/chat/completions", json({ model: "planner", messages: [{ role: "user", content: "I live in Pune now." }, { role: "assistant", content: "You live in Mumbai." }, { role: "user", content: "Book my usual table, I'm vegetarian." }] }));
    assert.equal(chat.status, 200);
    await settle();
    assert.deepEqual(read.at(-1), "Book my usual table, I'm vegetarian.", "only the last thing you said, never the replies");
  });
});
