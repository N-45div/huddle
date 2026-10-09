import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { agentzero } from "../src/connectors/agentzero.ts";
import { homeassistant } from "../src/connectors/homeassistant.ts";
import { Assistant } from "../src/schema.ts";
import type { Note } from "../src/store.ts";

const note: Note = { id: "note_1", slice: "home", note: "Guests sleep in the spare room.", status: "kept", source: "you", createdAt: "" };

describe("Home Assistant and Agent Zero", () => {
  const calls: { path: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }[] = [];
  let base = "";
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      calls.push({ path: request.url ?? "/", headers: request.headers, body });
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/conversation/process") {
        const understood = String(body.text).includes("lights");
        response.end(JSON.stringify({
          conversation_id: "conv-1",
          response: understood
            ? { response_type: "action_done", speech: { plain: { speech: "Turned off the kitchen lights." } }, data: { success: [{ id: "light.kitchen" }] } }
            : { response_type: "error", speech: { plain: { speech: "Sorry, I couldn't understand that" } }, data: { code: "no_intent_match" } },
        }));
        return;
      }
      if (request.url === "/api_message") {
        response.end(JSON.stringify({ context_id: "ctx-9", response: "Booked.\n```json\n{\"room\": \"spare\"}\n```" }));
        return;
      }
      response.statusCode = 404;
      response.end("{}");
    });
  });
  before(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)));
  before(() => {
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.HASS_TOKEN = "hass-token";
    process.env.AGENT_ZERO_API_KEY = "a0-key";
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("asks Home Assistant's Assist with a plain command and its token, and gets back what it did", async () => {
    const assistant = Assistant.parse({ id: "home", connector: "homeassistant", url: base, agentId: "conversation.home_assistant", memory: ["home"] });
    const answer = await homeassistant().send({ assistant, ask: "Turn off the kitchen lights", memory: [note] });
    assert.deepEqual(answer, { text: "Turned off the kitchen lights.", data: { type: "action_done", conversation: "conv-1", result: { success: [{ id: "light.kitchen" }] } } });
    const call = calls.at(-1)!;
    assert.equal(call.headers.authorization, "Bearer hass-token");
    assert.deepEqual(call.body, { text: "Turn off the kitchen lights", agent_id: "conversation.home_assistant" }, "no memory: Assist matches plain commands");
  });

  it("stops a flow when Home Assistant didn't understand, instead of carrying on", async () => {
    const assistant = Assistant.parse({ id: "home", connector: "homeassistant", url: base });
    await assert.rejects(homeassistant().send({ assistant, ask: "Make me a sandwich", memory: [] }), /couldn't do it: Sorry, I couldn't understand that/);
  });

  it("sends Agent Zero the request with its memory and key, and keeps its context id", async () => {
    const assistant = Assistant.parse({ id: "zero", connector: "agentzero", url: base, agentId: "researcher" });
    const answer = await agentzero().send({ assistant, ask: "Book a room for the guests", memory: [note] });
    assert.deepEqual(answer, { text: "Booked.\n```json\n{\"room\": \"spare\"}\n```", data: { room: "spare", context: "ctx-9" } });
    const call = calls.at(-1)!;
    assert.equal(call.path, "/api_message");
    assert.equal(call.headers["x-api-key"], "a0-key");
    assert.equal(call.body.agent_profile, "researcher");
    assert.match(String(call.body.message), /Book a room for the guests\n\nWhat you may use about me:\n- \(home\) Guests sleep in the spare room\./);
  });
});
