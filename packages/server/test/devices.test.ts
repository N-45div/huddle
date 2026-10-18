import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Engine, mock, parseFlow, Store } from "@huddle/core";
import { createApp } from "../src/app.ts";
import { DeviceHub, deviceRoutes, oneLine, type ToDevice } from "../src/devices.ts";

const ASKS = parseFlow({
  name: "Train booking",
  assistants: [{ id: "agent", connector: "mock", replies: { "*": "Booked." } }],
  steps: [
    { id: "ok", type: "approval", message: "Hermes wants to book the 6:40 train for ₹1,240.\n\nDetails: Shatabdi, coach C2." },
    { id: "book", type: "agent", agent: "agent", ask: "Book it" },
  ],
});
const BUTTON = parseFlow({ name: "Morning brief", trigger: { type: "button", input: "Today" }, assistants: [{ id: "agent", connector: "mock", replies: { "*": "Three things." } }], steps: [{ id: "brief", type: "agent", agent: "agent", ask: "{{input}}" }] });
const SCHEDULED = parseFlow({ name: "Weekly review", trigger: { type: "schedule", at: "18:00", on: ["fri"], input: "Week" }, steps: [{ id: "ok", type: "approval", message: "Review?" }] });

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("the Huddle button", () => {
  it("cuts an approval to one line it can say", () => {
    assert.equal(oneLine("Hermes wants to book the 6:40 train for ₹1,240.\n\nDetails…"), "Hermes wants to book the 6:40 train for ₹1,240.");
    assert.equal(oneLine("\n\n  Send   this?  "), "Send this?");
    const long = oneLine("Send this weekend plan to your partner: Saturday the palace and Chamundi Hill, Sunday the railway museum and back by the evening train", 60);
    assert.ok(long.length <= 60 && long.endsWith("…"), long);
  });

  it("shows today at a glance when nothing waits, with the flows it can start", () => {
    const store = new Store();
    const engine = new Engine(store, { mock });
    store.saveFlow(BUTTON);
    store.saveFlow(SCHEDULED);
    const screen = new DeviceHub(store, engine, () => Date.parse("2026-10-21T10:00:00+05:30")).screen();
    assert.equal(screen.type, "idle");
    if (screen.type !== "idle") return;
    assert.equal(screen.spentTodayUsd, 0);
    assert.equal(screen.nextRun?.flow, "Weekly review");
    assert.deepEqual(screen.flows.map((flow) => flow.name), ["Morning brief"]);
  });

  it("shows the oldest approval, takes a yes, and says when the run is done", async () => {
    const store = new Store();
    const engine = new Engine(store, { mock });
    const hub = new DeviceHub(store, engine);
    const sent: ToDevice[] = [];
    const session = hub.connect((message) => sent.push(message), { name: "Desk button", version: "test" });
    assert.deepEqual(sent.map((message) => message.type), ["hello", "idle"]);

    const saved = store.saveFlow(ASKS);
    await engine.start(ASKS, "", saved.id);
    await engine.start(ASKS, "", saved.id);
    const shown = sent.findLast((message) => message.type === "approval");
    assert.ok(shown && shown.type === "approval");
    assert.equal(shown.line, "Hermes wants to book the 6:40 train for ₹1,240.");
    assert.equal(shown.flow, "Train booking");
    assert.equal(shown.more, 1);

    session.receive(JSON.stringify({ type: "answer", id: shown.id, yes: true }));
    await settle();
    assert.ok(sent.some((message) => message.type === "answered" && message.yes));
    assert.ok(sent.some((message) => message.type === "run" && message.state === "done"), "a word for its face when the run ends");
    const after = sent.findLast((message) => message.type === "approval");
    assert.equal(after?.type === "approval" ? after.more : -1, 0, "the next one waiting comes up");

    session.receive("not json");
    session.receive(JSON.stringify({ type: "answer", id: "approval_gone", yes: true }));
    assert.deepEqual(sent.slice(-2).map((message) => message.type), ["error", "error"]);
    session.close();
  });

  it("starts a button flow with what you said, or its own input, and nothing else", async () => {
    const store = new Store();
    const engine = new Engine(store, { mock });
    const hub = new DeviceHub(store, engine);
    const button = store.saveFlow(BUTTON);
    const other = store.saveFlow(SCHEDULED);
    const sent: ToDevice[] = [];
    const session = hub.connect((message) => sent.push(message), { name: "Desk button", version: "test" });

    session.receive(JSON.stringify({ type: "start", flow: button.id }));
    session.receive(JSON.stringify({ type: "start", flow: button.id, input: "What's on Friday?" }));
    session.receive(JSON.stringify({ type: "start", flow: other.id }));
    await settle();
    const started = sent.filter((message) => message.type === "started");
    assert.equal(started.length, 2);
    const inputs = started.map((message) => (message.type === "started" ? store.run(message.runId)?.context.input : null));
    assert.deepEqual(inputs, ["Today", "What's on Friday?"]);
    assert.match(JSON.stringify(sent.findLast((message) => message.type === "error")), /isn't on the button/);
    const answers = sent.filter((message) => message.type === "run").map((message) => (message.type === "run" ? message.answer : null));
    assert.deepEqual(answers, ["Three things.", "Three things."], "a button run's answer comes back to say");
    const first = started[0]!.type === "started" ? started[0]!.runId : "";
    assert.deepEqual(store.logOf(first)[0]?.detail, { name: "Desk button", tier: "owner", via: "device" });
    session.close();
  });

  it("talks over a real WebSocket, with a device's token or the Huddle token, and nothing else", async () => {
    const store = new Store();
    const engine = new Engine(store, { mock });
    const app = createApp({ store, engine, version: "test", publicUrl: "http://huddle.test", token: "t0ken" });
    const websockets = createNodeWebSocket({ app });
    deviceRoutes(app, { store, engine, token: "t0ken", version: "test", upgradeWebSocket: websockets.upgradeWebSocket });
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    websockets.injectWebSocket(server);
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;

    const made = await app.request("/api/devices", { method: "POST", headers: { authorization: "Bearer t0ken", "content-type": "application/json" }, body: JSON.stringify({ name: "Desk button" }) });
    const { token } = (await made.json()) as { token: string };
    assert.match(token, /^hdl_d_/);

    const open = (query: string) =>
      new Promise<{ messages: ToDevice[]; socket: WebSocket }>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/devices/ws${query}`);
        const messages: ToDevice[] = [];
        socket.onmessage = (event) => {
          messages.push(JSON.parse(String(event.data)) as ToDevice);
          if (messages.length === 2) resolve({ messages, socket });
        };
        socket.onerror = () => reject(new Error("refused"));
      });
    const device = await open(`?token=${encodeURIComponent(token)}`);
    assert.deepEqual(device.messages[0], { type: "hello", name: "Desk button", version: "test" });
    assert.equal(device.messages[1]?.type, "idle");
    assert.ok(store.devices()[0]?.lastSeenAt, "seen");
    const virtual = await open("?token=t0ken");
    assert.equal(virtual.messages[0]?.type === "hello" ? virtual.messages[0].name : "", "Virtual button");
    await assert.rejects(open("?token=nope"), /refused/);

    device.socket.close();
    virtual.socket.close();
    await new Promise((resolve) => server.close(resolve));
  });
});
