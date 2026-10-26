import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Store } from "@huddle/core";
import { addStarters, STARTERS, starterCrew } from "../src/starters.ts";

describe("the starter crew", () => {
  it("is whoever this server's keys can run, and never carries a key's value", () => {
    assert.deepEqual(starterCrew({}), []);
    assert.deepEqual(starterCrew({ NEBIUS_API_KEY: "  " }).map((assistant) => assistant.id), [], "a blank key isn't a key");
    const crew = starterCrew({ NEBIUS_API_KEY: "tf-secret", TAVILY_API_KEY: "tvly-secret", CONTEXT_DEV_API_KEY: "ctx-secret" });
    assert.deepEqual(crew.map((assistant) => assistant.id), ["quick", "writer", "planner", "web", "reader"]);
    assert.deepEqual(crew.map((assistant) => assistant.connector), ["nebius", "nebius", "nebius", "tavily", "contextdev"]);
    assert.ok(crew.every((assistant) => assistant.description), "each says what it's for, for Just ask and the router's judge");
    assert.ok(!JSON.stringify(crew).includes("secret"));
    assert.deepEqual(starterCrew({ TAVILY_API_KEY: "t" }).map((assistant) => assistant.id), ["web"]);
  });

  it("is added once, to a Huddle with no assistants, and stays removed when you remove it", () => {
    const store = new Store();
    const crew = starterCrew({ NEBIUS_API_KEY: "tf" });
    assert.equal(addStarters(store, crew).length, 3);
    assert.deepEqual(store.assistants().map((assistant) => assistant.id), ["quick", "writer", "planner"]);
    store.saveAssistants([]);
    assert.deepEqual(addStarters(store, crew), [], "not again after you've removed them");
    assert.deepEqual(store.assistants(), []);
  });

  it("leaves a Huddle that already has assistants as it is, for good", () => {
    const store = new Store();
    const mine = starterCrew({ TAVILY_API_KEY: "t" });
    store.saveAssistants(mine);
    assert.deepEqual(addStarters(store, starterCrew({ NEBIUS_API_KEY: "tf" })), []);
    assert.deepEqual(store.assistants().map((assistant) => assistant.id), ["web"]);
    store.saveAssistants([]);
    assert.deepEqual(addStarters(store, starterCrew({ NEBIUS_API_KEY: "tf" })), [], "settled the first time");
  });

  it("waits for the keys: with none yet, nothing is settled", () => {
    const store = new Store();
    assert.deepEqual(addStarters(store, starterCrew({})), []);
    assert.equal(store.setting(STARTERS), null);
    assert.equal(addStarters(store, starterCrew({ NEBIUS_API_KEY: "tf" })).length, 3, "added once a key is set");
  });
});
