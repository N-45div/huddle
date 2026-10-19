import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { a2a, Assistant, type Connector, Engine, type Flow, mock, newKey, type OpenShell, OwnLimit, PactIdentity, parseFlow, Router, type Run, rulesPresenter, SignIns, Store, viewWriter } from "@huddle/core";
import { Hono } from "hono";
import { createApp, imagesIn } from "../src/app.ts";
import { describer } from "../src/describe.ts";
import { SandboxWatcher } from "../src/sandbox-requests.ts";
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
    assert.deepEqual(info, {
      version: "test",
      auth: true,
      agentCard: "http://huddle.test/.well-known/agent-card.json",
      describe: false,
      openshell: false,
      router: null,
      mcp: { url: "http://huddle.test/mcp", token: "HUDDLE_TOKEN" },
      email: { hook: "http://huddle.test/hooks/email", receiving: false },
      guard: null,
      present: { chooser: "rules", writer: null },
    });
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
    assert.equal(saved.a2aUrl, `http://huddle.test/a2a/flows/${saved.id}`);
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

  it("searches memory, best match first, within the slices asked for", async () => {
    const { app, store } = setup();
    store.remember("home", "Asha waters the plants.");
    store.remember("home", "Asha's passport expires in March.");
    store.remember("travel", "Renew the passport before booking flights.");
    store.suggest("home", "Asha might like a new passport cover.", "test");
    const search = async (query: string) => (await (await app.request(`/api/memory/search?${query}`, { headers: auth })).json()) as { note: { note: string; status: string }; match: { share: number } | null }[];
    const all = await search("q=when+does+Asha's+passport+expire");
    assert.equal(all[0]?.note.note, "Asha's passport expires in March.");
    assert.ok((all[0]?.match?.share ?? 0) > 0.9);
    assert.deepEqual((await search("q=passport&slice=travel")).map((hit) => hit.note.note), ["Renew the passport before booking flights."]);
    assert.deepEqual((await search("q=passport&slice=home&status=suggested")).map((hit) => hit.note.status), ["suggested"]);
    assert.equal((await app.request("/api/memory/search?q=+", { headers: auth })).status, 400);
    assert.equal((await app.request("/api/memory/search?q=passport")).status, 401);
  });

  it("proposes a tidy-up without changing anything, and merges what the person agrees to", async () => {
    const { app, store } = setup();
    // Copies from before memory stopped adding a note twice.
    const old = store.db.prepare("INSERT INTO notes (id, slice, note, status, source, created_at) VALUES (?, 'me', ?, ?, 'old', ?)");
    old.run("note_a", "Lives in Bengaluru", "kept", "2026-10-01T09:00:00.000Z");
    old.run("note_b", "lives in Bengaluru.", "kept", "2026-10-02T09:00:00.000Z");
    old.run("note_c", "Has a dog called Biscuit", "kept", "2026-10-03T09:00:00.000Z");
    old.run("note_d", "Dog's name is Biscuit, a beagle", "kept", "2026-10-04T09:00:00.000Z");
    assert.equal((await app.request("/api/memory/tidy", { method: "POST" })).status, 401);

    const tidy = await (await app.request("/api/memory/tidy", json({}))).json();
    assert.deepEqual(
      tidy.proposals.map((found: { kind: string; keep: string; notes: { id: string }[] }) => [found.kind, found.keep, found.notes.map((one) => one.id)]),
      [["copies", "note_a", ["note_a", "note_b"]]],
      "with no model, only exact copies",
    );
    assert.equal(tidy.readBy, null);
    assert.equal(store.notes().length, 4, "proposing changes nothing");

    const merged = await app.request("/api/memory/merge", json({ ids: ["note_c", "note_d"], note: "Has a beagle called Biscuit" }));
    assert.equal(merged.status, 201);
    assert.equal((await merged.json()).note, "Has a beagle called Biscuit");
    assert.equal((await app.request("/api/memory/merge", json({ ids: ["note_c", "note_a"], note: "x" }))).status, 409, "note_c is gone");
    assert.equal((await app.request("/api/memory/merge", json({ ids: "note_a", note: "x" }))).status, 400);
    assert.deepEqual(store.notes().map((one) => one.note).sort(), ["Has a beagle called Biscuit", "Lives in Bengaluru", "lives in Bengaluru."]);

    const { app: withModel } = setup({ tidy: async (notes) => ({ proposals: [], looked: notes.length, sent: notes.length, readBy: "nemotron", sentTo: ["api.tokenfactory.nebius.com"], costUsd: 0.0004, failed: [] }) });
    assert.equal((await (await withModel.request("/api/memory/tidy", json({}))).json()).readBy, "nemotron", "a set-up model tidies instead");
  });

  it("won't keep a password, a card number, a code or a key", async () => {
    const { app, store } = setup();
    const refused = await app.request("/api/memory", json({ slice: "home", note: "The wifi password is hunter22" }));
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /Not saved: this looks like a password/);
    store.db.prepare("INSERT INTO notes (id, slice, note, status, source, created_at) VALUES ('note_old', 'money', 'Card 4111 1111 1111 1111', 'suggested', 'old', ?)").run(new Date().toISOString());
    const kept = await app.request("/api/memory/note_old/keep", json({}));
    assert.equal(kept.status, 400);
    assert.match((await kept.json()).error, /Not kept: this looks like a card number/);
    assert.deepEqual(store.notes("kept"), []);
  });

  it("lists an Ollama's models for the assistant form, and says plainly when it can't reach one", async () => {
    const fetcher = (async (input: string | URL | Request) => {
      if (String(input) === "http://box:11434/api/tags") return Response.json({ models: [{ name: "qwen3:latest" }, { name: "gemma3:270m" }] });
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const { app } = setup({ fetcher });
    assert.equal((await app.request("/api/connectors/ollama/models?url=http://box:11434")).status, 401);
    assert.deepEqual(await (await app.request("/api/connectors/ollama/models?url=http://box:11434", { headers: auth })).json(), { models: ["gemma3:270m", "qwen3:latest"] });
    const down = await app.request("/api/connectors/ollama/models?url=http://nobody:1", { headers: auth });
    assert.equal(down.status, 502);
    assert.match((await down.json()).error, /Can't reach Ollama at http:\/\/nobody:1\. Is it running\?/);
    assert.equal((await app.request("/api/connectors/ollama/models?url=file:///etc/passwd", { headers: auth })).status, 400);
    assert.equal((await app.request("/api/connectors/openai/models", { headers: auth })).status, 404);
    const ollama = (await (await app.request("/api/connectors", { headers: auth })).json()).find((connector: { id: string }) => connector.id === "ollama");
    assert.equal(ollama.fields.find((field: { key: string }) => field.key === "model").suggest, "models");
  });

  it("drafts a flow from a sentence only when a model is set up", async () => {
    assert.equal((await setup().app.request("/api/describe", json({ text: "greet people" }))).status, 501);
    const { app } = setup({ describe: async () => greeter });
    const drafted = await (await app.request("/api/describe", json({ text: "greet people" }))).json();
    assert.equal(drafted.flow.name, "Greeter");
    // Past the budget or the minute's calls, it says to wait rather than that the request was wrong.
    const held = setup({
      describe: async () => {
        throw new OwnLimit("Huddle has made 30 of its own model calls in the last minute, its most, so describe it waits: try again in a minute.");
      },
    });
    const refused = await held.app.request("/api/describe", json({ text: "greet people" }));
    assert.equal(refused.status, 429);
    assert.match((await refused.json()).error, /try again in a minute/);
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

  it("gives each flow its own address and card, for assistants that can only send text to a URL", async () => {
    const { app, store } = setup({ a2aToken: "a2a-token-0123456789" });
    store.saveFlow(invoices);
    const saved = store.saveFlow(greeter);
    const peer = { authorization: "Bearer a2a-token-0123456789" };

    const card = await (await app.request(`/a2a/flows/${saved.id}/.well-known/agent-card.json`)).json();
    assert.equal(card.name, "Greeter");
    assert.deepEqual(card.supportedInterfaces, [{ url: `http://huddle.test/a2a/flows/${saved.id}`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }]);
    assert.deepEqual(card.skills.map((skill: { id: string }) => skill.id), [saved.id]);
    assert.equal((await app.request("/a2a/flows/flow_missing/.well-known/agent-card.json")).status, 404);

    // Hermes' a2a_call: plain text, no metadata, waits for the answer, though there are two flows.
    const waited = await (await app.request(`/a2a/flows/${saved.id}`, rpc("SendMessage", message("Ada"), peer))).json();
    assert.equal(waited.result.task.status.state, "TASK_STATE_COMPLETED");
    assert.deepEqual(waited.result.task.artifacts[0].parts, [{ text: "Hello from Huddle." }]);

    // OpenClaw's outbound peers: the same, but returnImmediately, then nobody asks again; the run still finishes.
    const quick = await (await app.request(`/a2a/flows/${saved.id}`, { ...rpc("SendMessage", { ...message("Ada"), configuration: { returnImmediately: true } }, peer) })).json();
    assert.equal(quick.result.task.status.state, "TASK_STATE_WORKING");
    assert.equal((await settle(store, quick.result.task.id)).state, "done");

    // No token: refused before saying whether the flow exists.
    assert.equal((await app.request("/a2a/flows/flow_missing", rpc("SendMessage", message("Ada")))).status, 401);
    assert.equal((await app.request("/a2a/flows/flow_missing", rpc("SendMessage", message("Ada"), peer))).status, 404);
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

describe("trust tiers: who may start a flow", () => {
  const rpc = (method: string, params: unknown, token?: string) => ({
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const message = (text: string) => ({ message: { messageId: "m1", role: "ROLE_USER", parts: [{ text }] } });
  const OWNER = "a2a-token-0123456789";

  it("starts the flow for close contacts and asks you first for the others, saying who it was", async () => {
    const { app, store, engine } = setup({ a2aToken: OWNER });
    const saved = store.saveFlow({ ...greeter, callers: { starts: "friend", others: "ask", strangers: "refuse" } });
    const asha = store.addContact({ name: "Asha", tier: "friend" });
    const ravi = store.addContact({ name: "Ravi", tier: "contact" });

    const close = (await (await app.request(`/a2a/flows/${saved.id}`, rpc("SendMessage", message("Ada"), asha.token))).json()).result.task;
    assert.equal(close.status.state, "TASK_STATE_COMPLETED");
    assert.deepEqual(store.logOf(close.id)[0]?.detail, { name: "Asha", tier: "friend", via: "a2a" });

    const further = (await (await app.request(`/a2a/flows/${saved.id}`, rpc("SendMessage", message("Ada"), ravi.token))).json()).result.task;
    assert.equal(further.status.state, "TASK_STATE_WORKING");
    assert.equal(further.status.message.parts[0].text, 'Waiting for the owner\'s approval: Ravi (contact) wants to run "Greeter" with: Ada');
    const waiting = store.waitingApproval(further.id);
    assert.ok(waiting);
    await engine.decide(waiting.id, true);
    assert.equal((await settle(store, further.id)).state, "done");

    // Each contact reads only the tasks they started; you read them all.
    const read = async (id: string, token: string) => (await (await app.request("/a2a", rpc("GetTask", { id }, token))).json()) as { result?: { status: { state: string } }; error?: { code: number } };
    assert.equal((await read(further.id, ravi.token)).result?.status.state, "TASK_STATE_COMPLETED");
    assert.equal((await read(further.id, asha.token)).error?.code, -32001);
    assert.equal((await read(further.id, OWNER)).result?.status.state, "TASK_STATE_COMPLETED");
    assert.ok(store.contact(asha.contact.id)?.lastSeenAt, "the contact was seen");
  });

  it("turns strangers away without saying whether the flow exists, unless the flow lets them ask", async () => {
    const { app, store } = setup({ a2aToken: OWNER });
    const closed = store.saveFlow(greeter);
    const open = store.saveFlow({ ...greeter, name: "Front desk", callers: { starts: "owner", others: "ask", strangers: "ask" } });

    for (const token of [undefined, "wrong-token", "hdl_c_made-up"]) {
      assert.equal((await app.request(`/a2a/flows/${closed.id}`, rpc("SendMessage", message("Hi"), token))).status, 401);
      assert.equal((await app.request("/a2a/flows/flow_missing", rpc("SendMessage", message("Hi"), token))).status, 401);
      assert.equal((await app.request("/a2a", rpc("SendMessage", message("Hi"), token))).status, 401, "the whole Huddle lists flows: not for strangers");
    }
    const asked = (await (await app.request(`/a2a/flows/${open.id}`, rpc("SendMessage", message("Can we talk Tuesday?")))).json()).result.task;
    assert.equal(asked.status.state, "TASK_STATE_WORKING");
    assert.match(store.waitingApproval(asked.id)?.message ?? "", /^Someone not in your contacts wants to run "Front desk" with: Can we talk Tuesday\?$/);
  });

  it("refuses contacts a flow doesn't take, and forgets removed or replaced tokens", async () => {
    const { app, store } = setup({ a2aToken: OWNER });
    const saved = store.saveFlow({ ...greeter, callers: { starts: "family", others: "refuse", strangers: "refuse" } });
    const friend = store.addContact({ name: "Asha", tier: "friend" });
    const refused = await (await app.request(`/a2a/flows/${saved.id}`, rpc("SendMessage", message("Hi"), friend.token))).json();
    assert.equal(refused.error.code, -32007);
    assert.equal(refused.error.message, '"Greeter" takes requests only from family and closer.');

    const mum = store.addContact({ name: "Mum", tier: "family" });
    const replaced = store.newContactToken(mum.contact.id)!;
    assert.equal((await app.request(`/a2a/flows/${saved.id}`, rpc("SendMessage", message("Hi"), mum.token))).status, 401, "the old token stopped working");
    assert.equal((await (await app.request(`/a2a/flows/${saved.id}`, rpc("SendMessage", message("Hi"), replaced))).json()).result.task.status.state, "TASK_STATE_COMPLETED");
    store.removeContact(mum.contact.id);
    assert.equal((await app.request(`/a2a/flows/${saved.id}`, rpc("SendMessage", message("Hi"), replaced))).status, 401);
  });

  it("manages contacts from the canvas, showing each token only once", async () => {
    const { app } = setup();
    const call = (path: string, method = "GET", body?: unknown) => app.request(path, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal((await call("/api/contacts", "POST", { name: "Asha", tier: "bestie" })).status, 400);
    const created = await (await call("/api/contacts", "POST", { name: " Asha ", tier: "friend", emails: ["Asha@Example.com", "not-an-email"] })).json();
    assert.match(created.token, /^hdl_c_/);
    assert.equal(created.contact.name, "Asha");
    assert.deepEqual(created.contact.emails, ["asha@example.com"]);
    const listed = await (await call("/api/contacts")).json();
    assert.equal(listed.length, 1);
    assert.ok(!JSON.stringify(listed).includes(created.token) && !("tokenHash" in listed[0]), "the list never shows a token");
    assert.equal((await (await call(`/api/contacts/${created.contact.id}`, "PATCH", { tier: "family" })).json()).tier, "family");
    assert.match((await (await call(`/api/contacts/${created.contact.id}/token`, "POST")).json()).token, /^hdl_c_/);
    assert.equal((await call(`/api/contacts/${created.contact.id}`, "DELETE")).status, 204);
    assert.equal((await call(`/api/contacts/${created.contact.id}`, "DELETE")).status, 404);
  });
});

describe("PACT sign-ins in Approvals", () => {
  it("lists the sign-ins waiting for you, checks one now, and cancels one", async () => {
    const signIns = new SignIns();
    const { app } = setup({ signIns });
    const call = (path: string, method = "GET") => app.request(path, { method, headers: { authorization: `Bearer ${TOKEN}` } });
    let polls = 0;
    const waiting = signIns.wait(
      { business: "Shop", assistant: "shop", runId: "run_1", scopes: [{ id: "orders:read", description: "Look up your orders" }] },
      { deviceCode: "dc", userCode: "CODE-1", link: "https://shop.example/login?code=CODE-1", expiresAt: Date.now() + 60_000, intervalSeconds: 30 },
      async () => {
        polls += 1;
        return { status: "pending" };
      },
    );
    const listed = await (await call("/api/signins")).json();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].business, "Shop");
    assert.equal(listed[0].link, "https://shop.example/login?code=CODE-1");
    assert.equal((await call(`/api/signins/${listed[0].id}/check`, "POST")).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(polls, 1, "checked with the business at once, not after 30 s");
    assert.equal((await call(`/api/signins/${listed[0].id}/cancel`, "POST")).status, 200);
    await assert.rejects(waiting, /You cancelled signing in to Shop/);
    assert.deepEqual(await (await call("/api/signins")).json(), []);
    assert.equal((await call(`/api/signins/${listed[0].id}/cancel`, "POST")).status, 404);
  });
});

describe("the router (OpenAI-compatible)", () => {
  /** A Huddle whose "http" assistants are a stand-in that records what it was sent, and fails for "down". */
  function routed(extra: Partial<Parameters<typeof createApp>[0]> = {}) {
    const store = new Store();
    const sent: { id: string; ask: string; memory: string[] }[] = [];
    const recorder: Connector = {
      async send({ assistant, ask, memory }) {
        sent.push({ id: assistant.id, ask, memory: memory.map((note) => note.note) });
        if (assistant.id === "down") throw new Error("down is offline");
        return { text: `${assistant.id} heard: ${ask}` };
      },
    };
    const engine = new Engine(store, { mock, http: recorder });
    const app = createApp({ store, engine, version: "test", publicUrl: "http://huddle.test", router: new Router(store, engine), ...extra });
    store.remember("home", "My cat is called Miso.");
    store.remember("money", "Rent is due on the 1st.");
    return { app, store, sent };
  }
  const chat = (body: object, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const mine = [
    { id: "hermes", name: "Hermes", connector: "http", url: "http://hermes.test", memory: ["home"] },
    { id: "down", connector: "http", url: "http://down.test" },
    { id: "local", connector: "mock", replies: { "*": "Local model here." } },
  ];

  it("keeps your assistants in one list, and says what's wrong with a bad one", async () => {
    const { app } = routed();
    assert.deepEqual(await (await app.request("/api/assistants")).json(), []);
    const bad = await app.request("/api/assistants", { ...chat({ assistants: [...mine, { id: "box", connector: "openshell" }] }), method: "PUT" });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).problems.join(" "), /runs in OpenShell: give its sandbox's name/);
    const twice = await app.request("/api/assistants", { ...chat({ assistants: [mine[0], mine[0]] }), method: "PUT" });
    assert.match((await twice.json()).problems.join(" "), /two assistants are called "hermes"/);
    const saved = await (await app.request("/api/assistants", { ...chat({ assistants: mine }), method: "PUT" })).json();
    assert.deepEqual(saved.map((one: { id: string }) => one.id), ["hermes", "down", "local"]);
    assert.equal((await (await app.request("/api/info")).json()).router, "http://huddle.test/v1");
  });

  it("lists your assistants as models, and answers a chat the way OpenAI does, with only that assistant's memory", async () => {
    const { app, store, sent } = routed();
    store.saveAssistants(mine.map((one) => Assistant.parse(one)));
    const models = await (await app.request("/v1/models")).json();
    assert.deepEqual(models.data.map((model: { id: string; object: string }) => [model.id, model.object]), [["auto", "model"], ["hermes", "model"], ["down", "model"], ["local", "model"]]);

    const reply = await (await app.request("/v1/chat/completions", chat({ model: "hermes", messages: [{ role: "user", content: "What's my cat called?" }] }))).json();
    assert.equal(reply.object, "chat.completion");
    assert.equal(reply.model, "hermes");
    assert.deepEqual(reply.choices[0].message, { role: "assistant", content: "hermes heard: What's my cat called?" });
    assert.deepEqual(sent.at(-1)?.memory, ["My cat is called Miso."], "the home slice only, never money");
    const run = store.run(reply.huddle.run);
    assert.deepEqual([run?.flow.name, run?.state], ["Router: Hermes", "done"], "the call shows in Runs");
  });

  it("carries the conversation, and falls back in order when an assistant fails", async () => {
    const { app, store, sent } = routed();
    store.saveAssistants(mine.map((one) => Assistant.parse(one)));
    await app.request("/v1/chat/completions", chat({ model: "hermes", messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Plan a walk." }, { role: "assistant", content: "Tomorrow at 5?" }, { role: "user", content: "Make it 6." }] }));
    assert.equal(sent.at(-1)?.ask, "Instructions: Be brief.\nMe: Plan a walk.\nYou: Tomorrow at 5?\n\nNow: Make it 6.");

    const fallback = await (await app.request("/v1/chat/completions", chat({ models: ["down", "local"], messages: [{ role: "user", content: "hi" }] }))).json();
    assert.equal(fallback.model, "local", "the one that answered");
    assert.equal(fallback.choices[0].message.content, "Local model here.");
    assert.deepEqual(fallback.huddle.skipped.map((skip: { id: string }) => skip.id), ["down"]);

    const allDown = await app.request("/v1/chat/completions", chat({ model: "down", messages: [{ role: "user", content: "hi" }] }));
    assert.equal(allDown.status, 502);
    assert.match((await allDown.json()).error.message, /down is offline/);
    const unknown = await app.request("/v1/chat/completions", chat({ model: "nobody", messages: [{ role: "user", content: "hi" }] }));
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, "model_not_found");
    assert.equal((await app.request("/v1/chat/completions", chat({ model: "local", messages: [{ role: "assistant", content: "hello" }] }))).status, 400);
  });

  it('routes "auto" through the judge, and reports how', async () => {
    const store = new Store();
    const engine = new Engine(store, { mock });
    store.saveAssistants([Assistant.parse({ id: "a", connector: "mock", replies: { "*": "A here." } }), Assistant.parse({ id: "b", connector: "mock", replies: { "*": "B here." } })]);
    const judge = { name: "jev", rank: async () => ({ judge: "jev", order: ["b", "a"], probabilities: { b: 0.8, a: 0.2 }, confidence: 0.7, model: "jev-1.13.0" }) };
    const app = createApp({ store, engine, version: "test", publicUrl: "http://huddle.test", router: new Router(store, engine, judge) });
    const reply = await (await app.request("/v1/chat/completions", chat({ model: "auto", messages: [{ role: "user", content: "hi" }] }))).json();
    assert.equal(reply.model, "b");
    assert.deepEqual([reply.huddle.route.judge, reply.huddle.route.confidence, reply.huddle.route.probabilities], ["jev", 0.7, { b: 0.8, a: 0.2 }]);
    const models = await (await app.request("/v1/models")).json();
    assert.match(models.data[0].description, /judged by jev/);
  });

  it('never lets "auto" pick an assistant that sends email', async () => {
    const { app, store } = routed();
    store.saveAssistants([Assistant.parse({ id: "mail", connector: "email", to: ["asha@example.com"], from: "huddle@mydomain.com" }), Assistant.parse(mine[2])]);
    const reply = await (await app.request("/v1/chat/completions", chat({ model: "auto", messages: [{ role: "user", content: "Email Asha that I'm late" }] }))).json();
    assert.equal(reply.model, "local", "first in your list, but it sends email: skipped");
    assert.equal(store.runs(10).length, 1);
  });

  it("counts each assistant's calls, failures and time to answer, for the Assistants page", async () => {
    const { app, store } = routed({ token: TOKEN });
    store.saveAssistants(mine.map((one) => Assistant.parse(one)));
    const ask = (model: string) => app.request("/v1/chat/completions", chat({ model, messages: [{ role: "user", content: "hi" }] }, auth));
    await ask("hermes");
    await ask("hermes");
    await ask("down");
    const view = await (await app.request("/api/router", { headers: auth })).json();
    assert.deepEqual([view.on, view.baseUrl, view.judge, view.keyRequired], [true, "http://huddle.test/v1", null, true]);
    const byId = Object.fromEntries(view.usage.map((row: { assistant: string }) => [row.assistant, row]));
    assert.deepEqual([byId.hermes.calls, byId.hermes.failures, typeof byId.hermes.averageMs], [2, 0, "number"]);
    assert.deepEqual([byId.down.calls, byId.down.failures, byId.down.averageMs], [1, 1, null]);
    assert.equal(byId.local, undefined, "never called");
  });

  it("answers with the real token counts and cost, keeps answers when allowed, and says what was spent and saved", async () => {
    const store = new Store();
    const paid: Connector = { send: async ({ assistant }) => ({ text: `${assistant.id} here.`, usage: { inputTokens: 1_000, outputTokens: 200 } }) };
    const engine = new Engine(store, { mock, openai: paid }, { budget: { usd: 10, period: "month" } });
    store.saveAssistants([
      Assistant.parse({ id: "claude", connector: "openai", url: "http://claude.test", price: { input: 3, output: 15 }, reuseMinutes: 30 }),
      Assistant.parse({ id: "local", connector: "mock", replies: { "*": "Local here." } }),
    ]);
    const app = createApp({ store, engine, version: "test", publicUrl: "http://huddle.test", router: new Router(store, engine) });
    const ask = (body: object, headers: Record<string, string> = {}) => app.request("/v1/chat/completions", chat({ messages: [{ role: "user", content: "What's on today?" }], ...body }, headers));

    const first = await (await ask({ model: "claude" })).json();
    assert.deepEqual(first.usage, { prompt_tokens: 1_000, completion_tokens: 200, total_tokens: 1_200 });
    assert.deepEqual(first.huddle.cost, { usd: 0.006, estimated: false, cachedTokens: 0 });
    assert.equal(first.huddle.reused, false);
    const again = await (await ask({ model: "claude" })).json();
    assert.deepEqual([again.huddle.reused, again.huddle.run, again.usage.total_tokens], [true, first.huddle.run, 0]);
    const fresh = await (await ask({ model: "claude" }, { "cache-control": "no-cache" })).json();
    assert.equal(fresh.huddle.reused, false, "Cache-Control: no-cache asks afresh");
    assert.equal((await (await ask({ model: "claude", huddle: { reuse: false } })).json()).huddle.reused, false);

    const local = await (await ask({ model: "local" })).json();
    assert.deepEqual([local.huddle.cost.usd, local.huddle.cost.estimated], [0, true], "a stand-in counts no tokens: guessed, and free");

    const bad = await ask({ model: "auto", huddle: { prefer: "fastest" } });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, "invalid_prefer");

    const view = await (await app.request("/api/router")).json();
    assert.deepEqual([view.spend.period, view.spend.budgetUsd, view.spend.reused], ["month", 10, 1]);
    assert.equal(Math.round(view.spend.spentUsd * 1e6), 18_000, "three paid calls at $0.006");
    assert.equal(Math.round(view.spend.savedByReuseUsd * 1e6), 6_000);
    const claude = view.usage.find((row: { assistant: string }) => row.assistant === "claude");
    assert.deepEqual([claude.calls, claude.reused, claude.unpriced, Math.round(claude.spentUsd * 1e6)], [3, 1, 0, 18_000]);
  });

  it("says the budget is spent with a 429, the way OpenAI says a quota is", async () => {
    const store = new Store();
    const paid: Connector = { send: async () => ({ text: "Done.", usage: { inputTokens: 1_000_000, outputTokens: 0 } }) };
    const engine = new Engine(store, { mock, openai: paid }, { budget: { usd: 1, period: "day" } });
    store.saveAssistants([Assistant.parse({ id: "claude", connector: "openai", url: "http://claude.test", price: { input: 3, output: 15 } })]);
    const app = createApp({ store, engine, version: "test", publicUrl: "http://huddle.test", router: new Router(store, engine) });
    const ask = () => app.request("/v1/chat/completions", chat({ model: "claude", messages: [{ role: "user", content: "hi" }] }));
    assert.equal((await ask()).status, 200, "the first call takes it over");
    const over = await ask();
    assert.equal(over.status, 429);
    const error = (await over.json()).error;
    assert.deepEqual([error.code, error.type], ["budget_exceeded", "insufficient_quota"]);
    assert.match(error.message, /The budget \(\$1\.00 a day\) is spent/);
  });

  it("shows answers as views: a table from records with no model, a chart a model filled in, checked, and says why not", async () => {
    const store = new Store();
    const engine = new Engine(store, { mock });
    const filled = (async () => Response.json({ choices: [{ message: { content: '{"title": "Spend", "unit": "$", "labels": ["Rent", "Food"], "series": [{"name": "October", "values": [1200, 400]}]}' } }] })) as unknown as typeof fetch;
    const app = createApp({ store, engine, version: "test", publicUrl: "http://huddle.test", present: { presenter: rulesPresenter, writer: viewWriter({ url: "http://model.test/v1", model: "small", fetcher: filled }) } });
    const presentIt = (body: object) => app.request("/api/present", chat(body));

    const table = await (await presentIt({ text: "Two invoices.", data: [{ vendor: "Northwind", amount: 450 }, { vendor: "Contoso", amount: 90 }], assistant: "finance" })).json();
    assert.deepEqual([table.choice.kind, table.view.kind, table.view.table.rows.length, table.view.source], ["table", "table", 2, "finance's answer"]);
    const chart = await (await presentIt({ text: "Rent 1200, food 400.", kind: "bar_chart", assistant: "finance" })).json();
    assert.deepEqual([chart.choice.by, chart.view.kind, chart.view.series[0].values], ["you", "bar_chart", [1200, 400]]);
    assert.equal((await presentIt({ text: "x", kind: "hologram" })).status, 400);
    const laidOut = await presentIt({ text: "No records here.", kind: "table" });
    assert.equal(laidOut.status, 502, "asked to lay text out as a table, the stand-in model sends a chart: refused");
    assert.match((await laidOut.json()).error, /couldn't fill in a table/);
    assert.equal((await (await app.request("/api/info")).json()).present.writer, "small");

    const noModel = createApp({ store, engine, version: "test", publicUrl: "http://huddle.test" });
    const refused = await noModel.request("/api/present", chat({ text: "Rent 1200", kind: "bar_chart" }));
    assert.equal(refused.status, 501);
    assert.equal((await noModel.request("/api/present", chat({ text: "Rent 1200", kind: "table" }))).status, 501, "no records and no model to lay them out");
    assert.match((await refused.json()).error, /set HUDDLE_LLM_URL and HUDDLE_LLM_MODEL/);
  });

  it("adds huddle.view to a /v1 answer when asked, and never loses the answer if the view fails", async () => {
    const store = new Store();
    const engine = new Engine(store, { mock });
    store.saveAssistants([Assistant.parse({ id: "finance", connector: "mock", replies: { "*": '[{"vendor": "Northwind", "amount": 450}]' } }), Assistant.parse({ id: "talk", connector: "mock", replies: { "*": "Rent 1200, food 400." } })]);
    const broken = (async () => Response.json({ error: { message: "overloaded" } }, { status: 529 })) as unknown as typeof fetch;
    const app = createApp({ store, engine, version: "test", publicUrl: "http://huddle.test", router: new Router(store, engine), present: { presenter: { name: "test", choose: async () => ({ kind: "bar_chart", by: "test", confidence: null }) }, writer: viewWriter({ url: "http://model.test/v1", model: "small", fetcher: broken }) } });
    const ask = (model: string, present: boolean) => app.request("/v1/chat/completions", chat({ model, messages: [{ role: "user", content: "My spending" }], huddle: { present } }));
    const plain = await (await ask("finance", false)).json();
    assert.equal(plain.huddle.view, undefined, "only when asked");
    const failed = await (await ask("talk", true)).json();
    assert.equal(failed.choices[0].message.content, "Rent 1200, food 400.");
    assert.match(failed.huddle.viewError, /The model said: overloaded/);
  });

  it("streams like OpenAI when asked", async () => {
    const { app, store } = routed();
    store.saveAssistants(mine.map((one) => Assistant.parse(one)));
    const response = await app.request("/v1/chat/completions", chat({ model: "local", stream: true, messages: [{ role: "user", content: "hi" }] }));
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const events = (await response.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6));
    assert.equal(events.at(-1), "[DONE]");
    const chunks = events.slice(0, -1).map((event) => JSON.parse(event));
    assert.equal(chunks.map((chunk) => chunk.choices[0].delta.content ?? "").join(""), "Local model here.");
    assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
  });

  it("wants the router key or the Huddle token when one is set", async () => {
    const { app, store } = routed({ token: TOKEN, routerKey: "router-key-0123456789" });
    store.saveAssistants(mine.map((one) => Assistant.parse(one)));
    assert.equal((await app.request("/v1/models")).status, 401);
    assert.equal((await (await app.request("/v1/models")).json()).error.code, "invalid_api_key");
    assert.equal((await app.request("/v1/models", { headers: { authorization: "Bearer router-key-0123456789" } })).status, 200);
    assert.equal((await app.request("/v1/models", { headers: auth })).status, 200);
  });
});

describe("Huddle as a PACT personal agent", () => {
  const identity = new PactIdentity("http://huddle.test", newKey(), "huddle-user-1");
  const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;

  it("publishes its public key for businesses to check, without needing Huddle's token", async () => {
    const { app } = setup({ pact: identity });
    const jwks = await (await app.request("/.well-known/jwks.json")).json();
    assert.deepEqual(jwks, identity.jwks());
    assert.equal("d" in (jwks.keys[0] ?? {}), false);
    assert.deepEqual(await (await app.request("/.well-known/openid-configuration")).json(), { issuer: "http://huddle.test", jwks_uri: "http://huddle.test/.well-known/jwks.json" });
    assert.equal((await app.request("/api/pact")).status, 401, "but the API still wants the token");
    assert.deepEqual(await (await app.request("/api/pact", { headers: auth })).json(), { issuer: "http://huddle.test", jwksUri: "http://huddle.test/.well-known/jwks.json", kid: identity.publicJwk().kid });
  });

  it("registers with a Provider the way PACT's reference Provider takes it, and says when it's already there", async () => {
    const calls: { url: string; token: Record<string, unknown>; body: Record<string, unknown> }[] = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const token = claimsOf(String((init?.headers as Record<string, string>).authorization).replace(/^Bearer /, ""));
      calls.push({ url: String(input), token, body: JSON.parse(String(init?.body)) });
      return calls.length === 1 ? Response.json({ id: "p1", audience: "http://provider.test/a2a" }, { status: 201 }) : Response.json({ error: "conflict" }, { status: 409 });
    }) as typeof fetch;
    const { app } = setup({ pact: identity, fetcher });
    const first = await app.request("/api/pact/register", json({ provider: "http://provider.test/", name: "my-huddle" }));
    assert.deepEqual(await first.json(), { registered: true, audience: "http://provider.test/a2a" });
    assert.equal(calls[0]!.url, "http://provider.test/api/platforms");
    assert.deepEqual([calls[0]!.token.iss, calls[0]!.token.sub, calls[0]!.token.aud], ["http://huddle.test", "http://huddle.test", "http://provider.test/api/platforms"]);
    assert.deepEqual(calls[0]!.body, { name: "my-huddle", jwksUri: "http://huddle.test/.well-known/jwks.json" });
    const again = await app.request("/api/pact/register", json({ provider: "http://provider.test", name: "my-huddle" }));
    assert.equal(again.status, 409);
    assert.match((await again.json()).error, /already has that name or Huddle's issuer registered/);
    assert.equal((await app.request("/api/pact/register", json({ provider: "ftp://x", name: "my-huddle" }))).status, 400);
    assert.equal((await app.request("/api/pact/register", json({ provider: "http://provider.test", name: "no spaces" }))).status, 400);
  });
});

describe("OpenShell sandbox requests", () => {
  const request = { sandbox: "agent", id: "chunk-1", rule: "allow_example_com_443", endpoints: ["example.com:443"], binary: "/usr/bin/bash", rationale: "Allow bash to connect to example.com:443 (HTTPS).", securityNotes: "", validation: "no new findings", hits: 1, firstSeen: null, reviewToken: "token-1" };

  /** A gateway with one pending request; `failApprove` makes the next approval fail as a stale review would. */
  function fakeShell() {
    const decided: string[] = [];
    let pending = [request];
    let down = false;
    let failApprove = false;
    const shell = {
      async sandboxes() {
        if (down) throw new Error("OpenShell: connection refused");
        return [{ name: "agent", phase: "ready" }, { name: "booting", phase: "provisioning" }];
      },
      async requests(sandbox: string) {
        return sandbox === "agent" ? pending : [];
      },
      async approve(sandbox: string, id: string, token: string) {
        if (failApprove) throw new Error("OpenShell: FAILED_PRECONDITION: review token no longer matches");
        decided.push(`approve ${sandbox}/${id} ${token}`);
        pending = [];
      },
      async reject(sandbox: string, id: string, reason: string) {
        decided.push(`reject ${sandbox}/${id} ${reason}`);
        pending = [];
      },
    };
    return { shell: shell as unknown as OpenShell, decided, set down(value: boolean) { down = value; }, set failApprove(value: boolean) { failApprove = value; } };
  }

  it("says plainly when Huddle isn't connected to OpenShell", async () => {
    const { app } = setup({ token: undefined });
    assert.equal((await (await app.request("/api/info")).json()).openshell, false);
    assert.deepEqual(await (await app.request("/api/sandbox-requests")).json(), { configured: false, connected: false, error: null, requests: [] });
    assert.equal((await app.request("/api/sandbox-requests/agent/chunk-1", json({ yes: true }))).status, 409);
  });

  it("shows what sandboxes are asking for, without the review token, and tells the canvas when it changes", async () => {
    const store = new Store();
    const changes: string[] = [];
    store.events.on("change", (change: { kind: string }) => changes.push(change.kind));
    const fake = fakeShell();
    const watcher = new SandboxWatcher(fake.shell, store);
    await watcher.refresh();
    const view = watcher.view();
    assert.equal(view.connected, true);
    assert.deepEqual(view.requests, [{ sandbox: "agent", id: "chunk-1", endpoints: ["example.com:443"], binary: "/usr/bin/bash", rationale: "Allow bash to connect to example.com:443 (HTTPS).", securityNotes: "", validation: "no new findings", hits: 1, firstSeen: null }]);
    await watcher.refresh();
    assert.deepEqual(changes, ["sandbox"], "nothing new the second time");
    fake.down = true;
    await watcher.refresh();
    assert.deepEqual([watcher.view().connected, watcher.view().error, watcher.view().requests.length], [false, "OpenShell: connection refused", 0]);
  });

  it("lets a request through with the token that was reviewed, or turns it down with a reason", async () => {
    const fake = fakeShell();
    const store = new Store();
    const watcher = new SandboxWatcher(fake.shell, store);
    const { app } = setup({ store, sandboxes: watcher, token: undefined });
    await watcher.refresh();
    assert.equal((await (await app.request("/api/info")).json()).openshell, true);
    assert.equal((await (await app.request("/api/sandbox-requests")).json()).requests.length, 1);
    assert.equal((await app.request("/api/sandbox-requests/agent/chunk-1", json({ yes: "ok" }))).status, 400);
    assert.equal((await app.request("/api/sandbox-requests/agent/chunk-1", json({ yes: true }))).status, 200);
    assert.deepEqual(fake.decided, ["approve agent/chunk-1 token-1"]);
    assert.equal((await (await app.request("/api/sandbox-requests")).json()).requests.length, 0);
    assert.equal((await app.request("/api/sandbox-requests/agent/chunk-1", json({ yes: true }))).status, 409, "already decided");

    const second = fakeShell();
    const other = new SandboxWatcher(second.shell, new Store());
    await other.refresh();
    await other.decide("agent", "chunk-1", false, "Not for this task.");
    assert.deepEqual(second.decided, ["reject agent/chunk-1 Not for this task."]);
  });

  it("asks the person to look again when the sandbox changed between showing and answering", async () => {
    const fake = fakeShell();
    const watcher = new SandboxWatcher(fake.shell, new Store());
    const { app } = setup({ sandboxes: watcher, token: undefined });
    await watcher.refresh();
    fake.failApprove = true;
    const answer = await app.request("/api/sandbox-requests/agent/chunk-1", json({ yes: true }));
    assert.equal(answer.status, 409);
    assert.match((await answer.json()).error, /It changed while you were looking/);
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
    assert.deepEqual(scheduler.scheduled().map((slot) => [slot.flowId, slot.schedule]), [[saved.id, "Every 15m"]]);
    store.saveFlow(every(greeter, "40d"), saved.id);
    assert.deepEqual(scheduler.scheduled().map((slot) => slot.schedule), ["Every 40d"]);
    // A time of day on some days, by a time zone's clock: the timer waits for the next one.
    store.saveFlow({ ...greeter, trigger: { type: "schedule", at: "18:00", on: ["fri"], timezone: "Asia/Kolkata", input: "weekend" } }, saved.id);
    const [friday] = scheduler.scheduled();
    assert.equal(friday?.schedule, "Fridays at 18:00 (Asia/Kolkata)");
    assert.equal(new Date(friday!.dueAt).getUTCDay(), 5);
    assert.equal(new Date(friday!.dueAt).toISOString().slice(11, 16), "12:30");
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

describe("images a run starts with", () => {
  it("are taken as data: URLs of PNG, JPEG, WebP or GIF, at most four, up to 5 MB each", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    assert.deepEqual(imagesIn(undefined), []);
    assert.deepEqual(imagesIn([png]), [png]);
    assert.match(String(imagesIn([png, png, png, png, png])), /at most 4/);
    assert.match(String(imagesIn(["https://example.com/a.png"])), /data: URL/);
    assert.match(String(imagesIn(["data:image/svg+xml;base64,PHN2Zz4="])), /PNG, JPEG, WebP or GIF/);
    assert.match(String(imagesIn([`data:image/jpeg;base64,${"A".repeat(7_100_000)}`])), /at most 5 MB/);
    assert.match(String(imagesIn("nope")), /a list/);
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

  it("offers the saved assistants, and puts each one it uses back exactly as saved", async () => {
    const saved = [{ id: "planner", connector: "nebius" as const, model: "nvidia/Nemotron-3-Ultra-550b-a55b", thinking: true, memory: ["me"], description: "Plans trips and budgets." }];
    let system = "";
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      system = (JSON.parse(String(init?.body)) as { messages: { content: string }[] }).messages[0]!.content;
      // The model names the saved assistant by id alone, and tries to point it elsewhere: Huddle keeps the saved one.
      return Response.json({ choices: [{ message: { content: JSON.stringify({ name: "Weekend", assistants: [{ id: "planner", connector: "http", url: "https://elsewhere.example" }], steps: [{ id: "plan", type: "agent", agent: "planner", ask: "plan my weekend" }] }) } }] });
    }) as typeof fetch;
    const flow = await describer({ url: "http://model.test/v1", model: "m", fetcher })("plan my weekend", saved);
    assert.match(system, /- planner: Plans trips and budgets\./);
    assert.deepEqual(flow.assistants[0], { ...saved[0] });
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

  it("serves files, sends the app's own pages to its hash routes, and never leaves its folder", async () => {
    assert.match(await (await app.request("/")).text(), /<title>Huddle/);
    const script = await app.request("/assets/app-1234.js");
    assert.equal(await script.text(), "console.log(1)");
    assert.match(script.headers.get("cache-control") ?? "", /immutable/);
    const deep = await app.request("/flows/flow_1?describe");
    assert.deepEqual([deep.status, deep.headers.get("location")], [302, "/#/flows/flow_1?describe"]);
    assert.equal((await app.request("/assets/gone-9999.js")).status, 404, "a missing file, not the page in its place");
    assert.equal((await app.request("/..%2fsecret.txt")).status, 404);
    assert.deepEqual(await (await app.request("/api/info")).json(), { ok: true });
    assert.equal((await app.request("/api/missing")).status, 404);
  });
});
