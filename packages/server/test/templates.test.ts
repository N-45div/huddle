import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mock, Engine, Store } from "@huddle/core";
import { createApp } from "../src/app.ts";
import { readTemplates } from "../src/templates.ts";

describe("templates", () => {
  it("offers every example flow, best first, each with a description and something to try", () => {
    const templates = readTemplates({ NEBIUS_API_KEY: "tf" });
    assert.equal(templates[0]?.id, "weekend-plan");
    assert.ok(templates.length >= 11, templates.map((template) => template.id).join(", "));
    assert.ok(templates.some((template) => template.id === "openshell-hermes/flow-nemotron"), "the sandboxed one, from its folder");
    assert.ok(!templates.some((template) => template.id === "openshell-hermes/flow"), "only the Nemotron one of the two");
    for (const template of templates) {
      assert.ok(template.flow.description, `${template.id} says what it does`);
      assert.ok(template.flow.example, `${template.id} has something to try`);
    }
  });

  it("says what this server still needs for each, and never a key's value", () => {
    const byId = new Map(readTemplates({ NEBIUS_API_KEY: "tf-secret" }).map((template) => [template.id, template]));
    assert.deepEqual(byId.get("weekend-plan")?.missing, []);
    assert.deepEqual(byId.get("weekend-plan")?.uses, ["NVIDIA Nemotron", "fact checks"]);
    assert.deepEqual(byId.get("who-is-this")?.missing, ["CONTEXT_DEV_API_KEY"]);
    assert.deepEqual(byId.get("invoices")?.missing, [], "stand-ins need nothing");
    assert.match(byId.get("openshell-hermes/flow-nemotron")?.missing.join() ?? "", /OpenShell gateway/);
    assert.ok(!JSON.stringify([...byId.values()]).includes("tf-secret"));
  });

  it("serves them to the canvas, behind the token", async () => {
    const store = new Store();
    const app = createApp({ store, engine: new Engine(store, { mock }), version: "test", publicUrl: "http://huddle.test", token: "t0ken" });
    assert.equal((await app.request("/api/templates")).status, 401);
    const served = (await (await app.request("/api/templates", { headers: { authorization: "Bearer t0ken" } })).json()) as { id: string }[];
    assert.equal(served[0]?.id, "weekend-plan");
  });
});
