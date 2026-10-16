import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Connector, ConnectorRequest } from "../src/connector.ts";
import { nebius } from "../src/connectors/nebius.ts";
import { Engine } from "../src/engine.ts";
import { receiptOf } from "../src/receipt.ts";
import { Assistant, parseFlow } from "../src/schema.ts";
import { Store } from "../src/store.ts";
import { NEMOTRON } from "../src/tokenfactory.ts";

const PHOTO = "data:image/png;base64,iVBORw0KGgo=";

describe("images a run starts with", () => {
  it("go only to an assistant allowed to see them, and the receipt counts them", async () => {
    const seen: Record<string, number> = {};
    const recorder: Connector = {
      async send(request: ConnectorRequest) {
        seen[request.assistant.id] = request.images?.length ?? 0;
        return { text: "read" };
      },
    };
    const flow = parseFlow({
      name: "Bill",
      assistants: [
        { id: "reader", connector: "nebius", model: NEMOTRON.vision, images: true },
        { id: "writer", connector: "nebius", model: NEMOTRON.super },
      ],
      steps: [
        { id: "read", type: "agent", agent: "reader", ask: "What's on this bill?" },
        { id: "write", type: "agent", agent: "writer", ask: "Summarise: {{read.text}}" },
      ],
    });
    const store = new Store();
    const run = await new Engine(store, { nebius: recorder }).start(flow, "", null, undefined, [PHOTO, PHOTO]);
    assert.deepEqual(seen, { reader: 2, writer: 0 });
    assert.deepEqual(store.run(run.id)?.context.images, [PHOTO, PHOTO]);
    assert.deepEqual(receiptOf(flow, store.logOf(run.id), store.notes()).disclosures.map((disclosure) => [disclosure.stepId, disclosure.images]), [["read", 2], ["write", 0]]);
  });

  it("are sent as image parts of the message to an OpenAI-style API", async () => {
    process.env.NEBIUS_API_KEY = "k";
    let content: unknown;
    const fetcher = (async (_url: string, init: RequestInit) => {
      content = (JSON.parse(String(init.body)) as { messages: { content: unknown }[] }).messages.at(-1)?.content;
      return Response.json({ choices: [{ message: { content: "A water bill for ₹640." } }] });
    }) as typeof fetch;
    const assistant = Assistant.parse({ id: "reader", connector: "nebius", model: NEMOTRON.vision, images: true });
    await nebius(fetcher).send({ assistant, ask: "What is it?", memory: [], images: [PHOTO] });
    assert.deepEqual(content, [{ type: "text", text: "What is it?" }, { type: "image_url", image_url: { url: PHOTO } }]);
    await nebius(fetcher).send({ assistant, ask: "What is it?", memory: [] });
    assert.equal(content, "What is it?", "without images, plain text as before");
    delete process.env.NEBIUS_API_KEY;
  });
});
