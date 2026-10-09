import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { a2a, Engine, type Flow, mock, parseFlow, type Run, Store } from "@huddle/core";
import { Hono } from "hono";
import { createApp } from "../src/app.ts";
import { describer } from "../src/describe.ts";
import { Scheduler } from "../src/scheduler.ts";
import { webApp } from "../src/static.ts";

const TOKEN = "test-token-0123456789";
const auth = { authorization: `Bearer ${TOKEN}` };
const json = (body: unknown) => ({ method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });

const invoices = parseFlow({
  name: "Invoices",
  description: "Reads an invoice and asks before paying a big one.",
  assistants: [
    { id: "finance", connector: "mock", memory: ["money"], replies: { "*": '{"vendor": "Northwind", "amount": 450}' } },
    { id: "calendar", connector: "mock", replies: { "*": "Reminder added." } },
  ],
  steps: [
    { id: "read", type: "agent", agent: "finance", ask: "Read: {{input}}" },
    { id: "big", type: "condition", if: "{{read.data.amount}} > 200", then: "ask-me", else: "remind" },
    { id: "ask-me", type: "approval", message: "Pay {{read.data.vendor}} {{read.data.amount}}?", next: "remind", onNo: "learn" },
    { id: "remind", type: "agent", agent: "calendar", ask: "Remind me to pay {{read.data.vendor}}." },
    { id: "learn", type: "memory", slice: "money", note: "{{read.data.vendor}} invoices us." },
  ],
});

const greeter = parseFlow({
  name: "Greeter",
  assistants: [{ id: "host", connector: "mock", replies: { "*": "Hello from Huddle." } }],
  steps: [{ id: "greet", type: "agent", agent: "host", ask: "Greet: {{input}}" }],
});

function setup(extra: Partial<Parameters<typeof createApp>[0]> = {}) {
  const store = new Store();
  const engine = new Engine(store, { mock });
  const app = createApp({ store, engine, version: "test", publicUrl: "http://huddle.test", token: TOKEN, ...extra });
  return { store, engine, app };
}

/** Waits for a background run to stop running (done, failed, declined, or waiting on a person). */
async function settle(store: Store, runId: string): Promise<Run> {
  for (let tries = 0; tries < 400; tries += 1) {
    const run = store.run(runId);
    if (run && run.state !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`run ${runId} never settled`);
}

describe("the API", () => {
  it("needs the token on /api, but not for the Agent Card or to learn that a token is needed", async () => {
    const { app } = setup();
    assert.equal((await app.request("/api/flows")).status, 401);
    assert.equal((await app.request("/api/flows", { headers: { authorization: "Bearer wrong-token-0123456789" } })).status, 401);
    assert.equal((await app.request("/api/flows", { headers: auth })).status, 200);
    const info = await (await app.request("/api/info")).json();
    assert.deepEqual(info, { version: "test", auth: true, agentCard: "http://huddle.test/.well-known/agent-card.json", describe: false });
    assert.equal((await app.request("/.well-known/agent-card.json")).status, 200);
  });

  it("is open on this machine when no token is set", async () => {
    const { app } = setup({ token: undefined });
    assert.equal((await app.request("/api/flows")).status, 200);
  });

  it("saves, lists, changes and deletes flows, and says what's wrong with a bad one", async () => {
    const { app } = setup();
    const bad = await app.request("/api/flows", json({ flow: { name: "Broken", steps: [{ id: "a", type: "agent", agent: "nobody", ask: "hi" }] } }));
    assert.equal(bad.status, 400);
    assert.deepEqual((await bad.json()).problems, ['step "a" asks "nobody", which isn\'t one of the flow\'s assistants']);

    const created = await app.request("/api/flows", json({ flow: invoices }));
    assert.equal(created.status, 201);
    const saved = await created.json();
    assert.match(saved.webhookUrl, new RegExp(`^http://huddle\\.test/hooks/${saved.id}/[0-9a-f]{32}$`));
    assert.equal((await (await app.request("/api/flows", { headers: auth })).json()).length, 1);

    const changed = await app.request(`/api/flows/${saved.id}`, { ...json({ flow: { ...invoices, name: "Bills" } }), method: "PUT" });
    assert.equal((await changed.json()).flow.name, "Bills");
    const rotated = await (await app.request(`/api/flows/${saved.id}/webhook/rotate`, json({}))).json();
    assert.notEqual(rotated.webhookUrl, saved.webhookUrl);

    assert.equal((await app.request("/api/flows/check", json({ flow: greeter }))).status, 200);
    assert.equal((await app.request(`/api/flows/${saved.id}`, { method: "DELETE", headers: auth })).status, 200);
    assert.equal((await app.request(`/api/flows/${saved.id}`, { headers: auth })).status, 404);
  });

  it("runs a flow in the background, holds it for an approval, and carries on when it's approved", async () => {
    const { app, store } = setup();
    const { id } = await (await app.request("/api/flows", json({ flow: invoices }))).json();
    const started = await app.request(`/api/flows/${id}/run`, json({ input: "Invoice #12" }));
    assert.equal(started.status, 202);
    const { runId } = await started.json();
    assert.equal((await settle(store, runId)).state, "waiting");

    const [waiting] = await (await app.request("/api/approvals", { headers: auth })).json();
    assert.equal(waiting.flowName, "Invoices");
    assert.equal(waiting.message, "Pay Northwind 450?");
    assert.equal((await app.request(`/api/approvals/${waiting.id}`, json({ yes: "sure" }))).status, 400);
    assert.equal((await app.request(`/api/approvals/${waiting.id}`, json({ yes: true }))).status, 202);
    assert.equal((await settle(store, runId)).state, "done");
    assert.equal((await app.request(`/api/approvals/${waiting.id}`, json({ yes: true }))).status, 409);

    const detail = await (await app.request(`/api/runs/${runId}`, { headers: auth })).json();
    assert.equal(detail.run.context.steps.remind.text, "Reminder added.");
    assert.ok(detail.log.some((line: { kind: string }) => line.kind === "approved"));
    const [summary] = await (await app.request(`/api/runs?flow=${id}`, { headers: auth })).json();
    assert.deepEqual([summary.id, summary.flowId, summary.state], [runId, id, "done"]);
  });

  it("starts a flow from its webhook, with the body as the input, and only at the secret address", async () => {
    const { app, store } = setup();
    const saved = await (await app.request("/api/flows", json({ flow: greeter }))).json();
    const path = new URL(saved.webhookUrl).pathname;
    assert.equal((await app.request(`/hooks/${saved.id}/${"0".repeat(32)}`, { method: "POST", body: "x" })).status, 404);

    const fromText = await (await app.request(path, { method: "POST", body: "a new lead" })).json();
    assert.equal((await settle(store, fromText.runId)).context.input, "a new lead");
    const fromJson = await (await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "from JSON" }) })).json();
    assert.equal((await settle(store, fromJson.runId)).context.input, "from JSON");
  });

  it("keeps a person's notes, lets suggestions be kept, and forgets on request", async () => {
    const { app, store } = setup();
    const note = await (await app.request("/api/memory", json({ slice: "home", note: "The cat is Miso." }))).json();
    assert.equal(note.status, "kept");
    assert.equal((await app.request("/api/memory", json({ slice: "home" }))).status, 400);
    const suggestion = store.suggest("money", "Rent is due on the 1st.", "test");
    assert.equal((await app.request(`/api/memory/${suggestion.id}/keep`, json({}))).status, 200);
    const kept = await (await app.request("/api/memory?status=kept", { headers: auth })).json();
    assert.deepEqual(kept.map((item: { note: string }) => item.note), ["The cat is Miso.", "Rent is due on the 1st."]);
    assert.equal((await app.request(`/api/memory/${note.id}`, { method: "DELETE", headers: auth })).status, 200);
    assert.equal((await app.request(`/api/memory/${note.id}`, { method: "DELETE", headers: auth })).status, 404);
  });

  it("drafts a flow from a sentence only when a model is set up", async () => {
    assert.equal((await setup().app.request("/api/describe", json({ text: "greet people" }))).status, 501);
    const { app } = setup({ describe: async () => greeter });
    const drafted = await (await app.request("/api/describe", json({ text: "greet people" }))).json();
    assert.equal(drafted.flow.name, "Greeter");
  });

  it("streams changes to the canvas, with the token in the query", async () => {
    const { app } = setup();
    assert.equal((await app.request("/api/events")).status, 401);
    const response = await app.request(`/api/events?token=${TOKEN}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = response.body!.getReader();
    await app.request("/api/memory", json({ slice: "home", note: "x" }));
    const { value } = await reader.read();
    assert.match(new TextDecoder().decode(value), /event: change\ndata: \{"kind":"memory"\}/);
    await reader.cancel();
  });
});

describe("Huddle over A2A", () => {
  const rpc = (method: string, params: unknown, headers: Record<string, string> = {}) => ({
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const message = (text: string, metadata?: object) => ({ message: { messageId: "m1", role: "ROLE_USER", parts: [{ text }], ...(metadata ? { metadata } : {}) } });

  it("lists the saved flows as skills on its Agent Card", async () => {
    const { app, store } = setup({ token: undefined });
    const saved = store.saveFlow(invoices);
    const card = await (await app.request("/.well-known/agent-card.json")).json();
    assert.deepEqual(card.supportedInterfaces, [{ url: "http://huddle.test/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" }]);
    assert.deepEqual(card.skills.map((skill: { id: string; name: string }) => [skill.id, skill.name]), [[saved.id, "Invoices"]]);
    assert.equal(card.securitySchemes, undefined);
  });

  it("runs the flow a message asks for and answers with its result", async () => {
    const { app, store } = setup({ token: undefined });
    store.saveFlow(invoices);
    const saved = store.saveFlow(greeter);
    const sent = await (await app.request("/a2a", rpc("SendMessage", message("Ada", { flow: "greeter" })))).json();
    const task = sent.result.task;
    assert.equal(task.status.state, "TASK_STATE_COMPLETED");
    assert.deepEqual(task.artifacts[0].parts, [{ text: "Hello from Huddle." }]);
    assert.equal(task.metadata.flow, saved.id);
    const got = await (await app.request("/a2a", rpc("GetTask", { id: task.id }))).json();
    assert.equal(got.result.contextId, task.contextId);

    const unsure = await (await app.request("/a2a", rpc("SendMessage", message("Ada")))).json();
    assert.equal(unsure.error.code, -32602);
    assert.match(unsure.error.message, /Say which flow/);
  });

  it("keeps a task working while the owner decides, and won't show runs that didn't come over A2A", async () => {
    const { app, store, engine } = setup({ token: undefined });
    store.saveFlow(invoices);
    const task = (await (await app.request("/a2a", rpc("SendMessage", message("Invoice #12")))).json()).result.task;
    assert.equal(task.status.state, "TASK_STATE_WORKING");
    assert.match(task.status.message.parts[0].text, /Waiting for the owner's approval: Pay Northwind 450\?/);

    const local = await engine.start(greeter, "not for you");
    const hidden = await (await app.request("/a2a", rpc("GetTask", { id: local.id }))).json();
    assert.equal(hidden.error.code, -32001);
    const unknown = await (await app.request("/a2a", rpc("CancelTask", { id: task.id }))).json();
    assert.equal(unknown.error.code, -32601);
  });

  it("needs its token, and then doesn't name the flows on the public card", async () => {
    const { app, store } = setup({ a2aToken: "a2a-token-0123456789" });
    store.saveFlow(greeter);
    assert.equal((await app.request("/a2a", rpc("SendMessage", message("Ada")))).status, 401);
    assert.equal((await app.request("/a2a", rpc("SendMessage", message("Ada"), auth))).status, 401);
    const ok = await (await app.request("/a2a", rpc("SendMessage", message("Ada"), { authorization: "Bearer a2a-token-0123456789" }))).json();
    assert.equal(ok.result.task.status.state, "TASK_STATE_COMPLETED");
    const card = await (await app.request("/.well-known/agent-card.json")).json();
    assert.deepEqual(card.skills.map((skill: { id: string }) => skill.id), ["flow"]);
    assert.deepEqual(card.securityRequirements, [{ schemes: { bearer: { list: [] } } }]);
  });

  it("can be one step in another Huddle's flow, through Huddle's own A2A connector", async () => {
    const { app, store } = setup({ token: undefined });
    store.saveFlow(greeter);
    const fetcher = ((input: string | URL | Request, init?: RequestInit) => app.request(String(input), init)) as typeof fetch;
    const caller = new Engine(new Store(), { a2a: a2a(fetcher, { pollMs: 5 }) });
    const flow = parseFlow({
      name: "Ask the other Huddle",
      assistants: [{ id: "other", connector: "a2a", url: "http://huddle.test" }],
      steps: [{ id: "hello", type: "agent", agent: "other", ask: "Ada" }],
    });
    const view = await caller.start(flow, "");
    assert.equal(view.state, "done");
    assert.equal(view.context.steps.hello?.text, "Hello from Huddle.");
  });
});

describe("schedules", () => {
  const every = (flow: Flow, value: string): Flow => ({ ...flow, trigger: { type: "schedule", every: value, input: "on schedule" } });

  it("follows the saved flows: new schedules start, changed ones restart, removed ones stop", () => {
    const store = new Store();
    const scheduler = new Scheduler(store, new Engine(store, { mock }));
    scheduler.start();
    const saved = store.saveFlow(every(greeter, "15m"));
    store.saveFlow(invoices);
    assert.deepEqual(scheduler.scheduled().map((slot) => [slot.flowId, slot.every]), [[saved.id, "15m"]]);
    store.saveFlow(every(greeter, "40d"), saved.id);
    assert.deepEqual(scheduler.scheduled().map((slot) => slot.every), ["40d"]);
    store.deleteFlow(saved.id);
    assert.deepEqual(scheduler.scheduled(), []);
    scheduler.stop();
  });

  it("runs with the schedule's input, and skips while the last run is waiting on a person", async () => {
    const store = new Store();
    const scheduler = new Scheduler(store, new Engine(store, { mock }));
    const saved = store.saveFlow(every(invoices, "1h"));
    const first = scheduler.fire(saved.id);
    assert.ok(first);
    const run = await settle(store, first);
    assert.deepEqual([run.state, run.context.input], ["waiting", "on schedule"]);
    assert.equal(scheduler.fire(saved.id), null);
  });

  it("marks runs cut off by a restart as failed, and leaves waiting ones alone", async () => {
    const store = new Store();
    const engine = new Engine(store, { mock });
    const cut = store.createRun(greeter, "x");
    const waiting = await engine.start(invoices, "y");
    assert.equal(store.failInterrupted(), 1);
    assert.equal(store.run(cut.id)?.state, "failed");
    assert.equal(store.run(waiting.id)?.state, "waiting");
  });
});

describe("describe it", () => {
  it("gives the model one more go with the problems listed, and returns a checked flow", async () => {
    const bodies: { messages: { role: string; content: string }[] }[] = [];
    const replies = ['```json\n{"name": "Greeter", "steps": [{"id": "greet", "type": "agent", "agent": "host", "ask": "hi"}]}\n```', JSON.stringify(greeter)];
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ choices: [{ message: { content: replies[bodies.length - 1] } }] });
    }) as typeof fetch;
    const flow = await describer({ url: "http://model.test/v1", model: "m", fetcher })("greet people");
    assert.equal(flow.name, "Greeter");
    assert.equal(bodies.length, 2);
    assert.match(bodies[1]!.messages.at(-1)!.content, /isn't one of the flow's assistants/);
  });

  it("keeps the key out of the model's errors", async () => {
    const fetcher = (async () => Response.json({ error: { message: "bad key sk-secret-123" } }, { status: 401 })) as typeof fetch;
    await assert.rejects(describer({ url: "http://model.test/v1/chat/completions", model: "m", key: "sk-secret-123", fetcher })("x"), /The model said: bad key \[key\]/);
  });
});

describe("the web app files", () => {
  const dir = mkdtempSync(join(tmpdir(), "huddle-web-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const dist = join(dir, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>Huddle</title>");
  writeFileSync(join(dist, "assets", "app-1234.js"), "console.log(1)");
  writeFileSync(join(dir, "secret.txt"), "nope");
  const app = new Hono();
  app.get("/api/info", (c) => c.json({ ok: true }));
  app.use("*", webApp(dist));

  it("serves files, falls back to the app for its own pages, and never leaves its folder", async () => {
    const script = await app.request("/assets/app-1234.js");
    assert.equal(await script.text(), "console.log(1)");
    assert.match(script.headers.get("cache-control") ?? "", /immutable/);
    assert.match(await (await app.request("/flows/flow_1")).text(), /<title>Huddle/);
    assert.match(await (await app.request("/..%2fsecret.txt")).text(), /<title>Huddle/);
    assert.deepEqual(await (await app.request("/api/info")).json(), { ok: true });
    assert.equal((await app.request("/api/missing")).status, 404);
  });
});
