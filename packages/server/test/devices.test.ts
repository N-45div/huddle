import assert from "node:assert/strict";
import { type AddressInfo, connect } from "node:net";
import { describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Engine, mock, parseFlow, type Speech, Store } from "@huddle/core";
import { createApp } from "../src/app.ts";
import { asSpoken, DeviceHub, deviceRoutes, guardUpgrades, oneLine, shortAnswer, spokenParts, type ToDevice, VOICE_NOTE } from "../src/devices.ts";

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

  it("says a long answer in whole sentences, not cut mid-sentence", () => {
    const answer = `${"Bengaluru is cloudy at 24 degrees this afternoon with a light breeze from the west. ".repeat(3)}It may rain after six, so take an umbrella if you head out for dinner tonight.`;
    const said = shortAnswer(answer, 300);
    assert.ok(said.endsWith(".") && said.length <= 300, said);
    assert.equal(shortAnswer("Short and sweet."), "Short and sweet.");
    const noStop = shortAnswer("word ".repeat(100), 60);
    assert.ok(noStop.endsWith("…") && noStop.length <= 61, noStop);
  });

  it("joins short sentences so speech has no gap after a quick hello", () => {
    assert.deepEqual(spokenParts("Hello! I'm Hud, from Huddle. What can I do for you?"), ["Hello! I'm Hud, from Huddle. What can I do for you?"]);
    const long = "This sentence is long enough to be said on its own, without waiting for another one to join it here. ";
    assert.ok(long.trim().length >= 90);
    assert.equal(spokenParts(long.repeat(3)).length, 3);
  });

  it("answers a spoken ask as Hud, in the step whose answer is said, never in the saved flow", () => {
    const two = parseFlow({
      name: "Two steps",
      trigger: { type: "button", input: "Today" },
      assistants: [{ id: "agent", connector: "mock", replies: { "*": "Done." } }],
      steps: [
        { id: "look", type: "agent", agent: "agent", ask: "Look up {{input}}" },
        { id: "tell", type: "agent", agent: "agent", ask: "Tell me {{look}}" },
      ],
    });
    const spoken = asSpoken(two);
    const ask = (flow: typeof two, id: string) => flow.steps.find((step) => step.id === id && step.type === "agent")?.type === "agent" ? (flow.steps.find((step) => step.id === id) as { ask: string }).ask : "";
    assert.equal(ask(spoken, "look"), "Look up {{input}}");
    assert.ok(ask(spoken, "tell").startsWith(VOICE_NOTE) && ask(spoken, "tell").endsWith("Tell me {{look}}"));
    assert.equal(ask(two, "tell"), "Tell me {{look}}");
    assert.match(VOICE_NOTE, /Hud, from Huddle/);
  });

  it("starts a spoken button run with Hud's note, and a preset one without", async () => {
    const store = new Store();
    const engine = new Engine(store, { mock });
    const saved = store.saveFlow(BUTTON);
    const hub = new DeviceHub(store, engine);
    const spoken = hub.start(saved.id, "who are you?", "Desk button");
    const preset = hub.start(saved.id, null, "Desk button");
    await settle();
    const askOf = (runId: string) => (store.logOf(runId).find((line) => line.kind === "asked")?.detail as { ask?: string } | null)?.ask ?? "";
    assert.ok(askOf(spoken.runId).startsWith(VOICE_NOTE) && askOf(spoken.runId).endsWith("who are you?"));
    // Who'll answer, for the button to show their Huddler while they work.
    assert.deepEqual(spoken.assistant, { id: "agent", name: "agent", connector: "mock" });
    assert.equal(askOf(preset.runId), "Today");
    assert.equal(store.flow(saved.id)?.flow.steps[0]?.type === "agent" && (store.flow(saved.id)?.flow.steps[0] as { ask: string }).ask, "{{input}}");
  });

  it("shows today at a glance when nothing waits, with the flows it can start", () => {
    const store = new Store();
    const engine = new Engine(store, { mock });
    store.saveFlow(BUTTON);
    store.saveFlow(SCHEDULED);
    const screen = new DeviceHub(store, engine, { now: () => Date.parse("2026-10-21T10:00:00+05:30") }).screen();
    assert.equal(screen.type, "idle");
    if (screen.type !== "idle") return;
    assert.equal(screen.spentTodayUsd, 0);
    assert.equal(screen.nextRun?.flow, "Weekly review");
    // In this machine's time, ready for a screen that has no time zone.
    const at = new Date(screen.nextRun?.at ?? 0);
    assert.equal(screen.nextRun?.label, at.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" }));
    assert.match(screen.nextRun?.label ?? "", /^\w{3} \d{1,2}:\d{2} [AP]M$/);
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

  it("takes the photo the button sent while you talked to a flow that sees, and tells the button which flows see", async () => {
    const speech: Speech = {
      name: "test speech",
      url: "http://127.0.0.1:8090",
      async transcribe() {
        return "What does this say?";
      },
      async speak() {
        return new Uint8Array(0);
      },
    };
    const LOOK = parseFlow({
      name: "Look at this",
      trigger: { type: "button", input: "What's this?" },
      assistants: [{ id: "eye", connector: "mock", images: true, replies: { "*": "A bill for 340 rupees." } }],
      steps: [{ id: "say", type: "agent", agent: "eye", ask: "{{input}}" }],
    });
    const store = new Store();
    const engine = new Engine(store, { mock });
    const hub = new DeviceHub(store, engine, { speech });
    const look = store.saveFlow(LOOK);
    store.saveFlow(BUTTON);
    const screen = hub.screen();
    assert.deepEqual(screen.type === "idle" ? screen.flows.map((flow) => [flow.name, flow.sees]) : [], [["Look at this", true], ["Morning brief", false]]);

    const sent: ToDevice[] = [];
    const session = hub.connect((message) => sent.push(message), { name: "Desk button", version: "test" });
    session.receive(JSON.stringify({ type: "listen", flow: look.id }));
    session.receive(JSON.stringify({ type: "photo", jpeg: "/9j/4AAQSkZJRg==" }));
    session.receiveAudio(new Uint8Array(32_000));
    session.receive(JSON.stringify({ type: "stop" }));
    await settle();
    const started = sent.find((message) => message.type === "started");
    assert.ok(started && started.type === "started");
    assert.deepEqual(store.run(started.runId)?.context.images, ["data:image/jpeg;base64,/9j/4AAQSkZJRg=="]);
    assert.equal((store.logOf(started.runId).find((line) => line.kind === "asked")?.detail as { images?: number }).images, 1, "the assistant that sees got it");

    // A photo that isn't base64, or comes when nothing's listening, is refused.
    session.receive(JSON.stringify({ type: "photo", jpeg: "/9j/4AAQ" }));
    assert.equal(sent.at(-1)?.type, "error");
    session.close();
  });

  it("with speech set up, says the approval in spoken form, and starts a flow with what you said", async () => {
    const spoken: string[] = [];
    const speech: Speech = {
      name: "test speech, on this machine",
      url: "http://127.0.0.1:8090",
      async transcribe(pcm) {
        return pcm.byteLength >= 32_000 ? "What's on Friday?" : "";
      },
      async speak(text) {
        spoken.push(text);
        return new Uint8Array(10_000);
      },
    };
    const store = new Store();
    const engine = new Engine(store, { mock });
    const hub = new DeviceHub(store, engine, { speech });
    const button = store.saveFlow(BUTTON);
    const asks = store.saveFlow(ASKS);
    const sent: ToDevice[] = [];
    const audio: Uint8Array[] = [];
    const session = hub.connect((message) => sent.push(message), { name: "Desk button", version: "test" }, (chunk) => audio.push(chunk));
    assert.equal(sent[0]?.type === "hello" && sent[0].speech, true);

    // Quiet until the device says it plays audio.
    session.receive(JSON.stringify({ type: "hello", audio: true }));
    await engine.start(ASKS, "", asks.id);
    await settle();
    assert.deepEqual(spoken, ["Train booking. Hermes wants to book the six forty train for one thousand two hundred forty rupees."], "in spoken form, the short flow name joined to the next sentence");
    assert.deepEqual(sent.filter((message) => message.type === "speaking" || message.type === "spoken").map((message) => message.type), ["speaking", "spoken"]);
    assert.equal(audio.reduce((sum, chunk) => sum + chunk.byteLength, 0), 10_000, "the audio, in frames");

    // Hold and talk: a second of audio, then let go.
    session.receive(JSON.stringify({ type: "listen", flow: button.id }));
    session.receiveAudio(new Uint8Array(16_000));
    session.receiveAudio(new Uint8Array(16_000));
    session.receive(JSON.stringify({ type: "stop" }));
    await settle();
    assert.ok(sent.some((message) => message.type === "heard" && message.text === "What's on Friday?"));
    const started = sent.find((message) => message.type === "started");
    assert.ok(started && started.type === "started");
    assert.equal(store.run(started.runId)?.context.input, "What's on Friday?");
    assert.deepEqual(store.logOf(started.runId).find((line) => line.kind === "heard")?.detail, { by: "test speech, on this machine", local: true, seconds: 1, chars: 17 });

    // Nothing said: it says so, and starts nothing.
    const before = sent.filter((message) => message.type === "started").length;
    session.receive(JSON.stringify({ type: "listen", flow: button.id }));
    session.receive(JSON.stringify({ type: "stop" }));
    await settle();
    assert.equal(sent.filter((message) => message.type === "started").length, before);
    assert.equal(spoken.at(-1), "Sorry, I didn't catch that.");
    session.close();
  });

  it("keeps running when a device drops off in the middle of connecting", async () => {
    const store = new Store();
    const engine = new Engine(store, { mock });
    const app = createApp({ store, engine, version: "test", publicUrl: "http://huddle.test", token: "t0ken" });
    const websockets = createNodeWebSocket({ app });
    deviceRoutes(app, { store, engine, token: "t0ken", version: "test", upgradeWebSocket: websockets.upgradeWebSocket });
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    websockets.injectWebSocket(server);
    guardUpgrades(server);
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      // A device with a wrong token drops off before hearing no (a page reloading does this too).
      for (let attempt = 0; attempt < 5; attempt++) {
        const socket = connect(port, "127.0.0.1");
        await new Promise((resolve) => socket.once("connect", resolve));
        socket.write("GET /devices/ws?token=nope HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
        socket.resetAndDestroy();
      }
      await settle();
      const info = await fetch(`http://127.0.0.1:${port}/api/info`, { headers: { authorization: "Bearer t0ken" } });
      assert.equal(info.status, 200, "still serving");
    } finally {
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
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

    try {
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
    assert.deepEqual(device.messages[0], { type: "hello", name: "Desk button", version: "test", speech: false });
    assert.equal(device.messages[1]?.type, "idle");
    assert.ok(store.devices()[0]?.lastSeenAt, "seen");
    const virtual = await open("?token=t0ken");
    assert.equal(virtual.messages[0]?.type === "hello" ? virtual.messages[0].name : "", "Virtual button");
    await assert.rejects(open("?token=nope"), /refused/);

    device.socket.close();
    virtual.socket.close();
    } finally {
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
