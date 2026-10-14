import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Assistant } from "../../core/src/schema.ts";
import { CONNECTORS } from "../src/connectors-info.ts";

describe("the add-assistant form's connectors", () => {
  it("cover every connector a flow can name, and only those", () => {
    const named = Assistant.shape.connector.options;
    const offered = CONNECTORS.map((connector) => connector.id);
    assert.deepEqual([...offered].sort(), [...named].sort());
  });

  it("ask a Monid tool for its tool, and offer its input template, spend cap, wait and key", () => {
    const monid = CONNECTORS.find((connector) => connector.id === "monid");
    assert.deepEqual(
      monid?.fields.map((field) => `${field.key}${field.required ? "*" : ""}`),
      ["tool*", "input", "maxUsd", "waitSeconds", "keyEnv"],
    );
  });
});
