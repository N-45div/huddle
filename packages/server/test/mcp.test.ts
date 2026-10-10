import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Assistant, type Connector, Engine, mock, parseFlow, Router, type SavedFlow, Store } from "@huddle/core";
import { createApp } from "../src/app.ts";
import { toolNames } from "../src/mcp.ts";

const OWNER = "a2a-token-0123456789";
const MODERN = "2026-07-28";

const greeter = parseFlow({
  name: "Greeter",
  description: "Says hello.",
  assistants: [{ id: "host", connector: "mock", replies: { "*": "Hello from Huddle." } }],
  steps: [{ id: "greet", type: "agent", agent: "host", ask: "Greet: {{input}}" }],
});

const invoices = parseFlow({
  name: "Invoices",
  assistants: [
    { id: "finance", connector: "mock", replies: { "*": '{"vendor": "Northwind", "amount": 450}' } },
    { id: "calendar", connector: "mock", replies: { "*": "Reminder added." } },
  ],
  steps: [
    { id: "read", type: "agent", agent: "finance", ask: "Read: {{input}}" },
    { id: "ask-me", type: "approval", message: "Pay {{read.data.vendor}} {{read.data.amount}}?" },
    { id: "remind", type: "agent", agent: "calendar", ask: "Remind me to pay {{read.data.vendor}}." },
  ],
});

function setup(extra: Partial<Parameters<typeof createApp>[0]> = {}) {
  const store = new Store();
  const engine = new Engine(store, { mock });
  const app = createApp({ store, engine, version: "test", publicUrl: "http://huddle.test", a2aToken: OWNER, ...extra });
  return { store, engine, app };
}

type App = ReturnType<typeof setup>["app"];
interface Reply {
  readonly status: number;
  readonly body: { id?: unknown; result?: Record<string, unknown> & { content?: { text: string }[]; isError?: boolean }; error?: { code: number; message: string; data?: unknown } } | null;
}

/** One JSON-RPC request the way a 2025 client sends it, after initialize. */
async function legacy(app: App, method: string, params: object = {}, token: string | null = OWNER, headers: Record<string, string> = {}): Promise<Reply> {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: response.status, body: response.status === 202 ? null : await response.json() };
}

/** One JSON-RPC request the way a 2026-07-28 client sends it: its version in _meta and in the headers. */
async function modern(app: App, method: string, params: Record<string, unknown> = {}, token: string | null = OWNER, headers: Record<string, string> = {}): Promise<Reply> {
  const meta = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" } };
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MODERN,
      "mcp-method": method,
      ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params: { ...params, _meta: meta } }),
  });
  return { status: response.status, body: await response.json() };
}

const call = (app: App, name: string, args: object, token: string | null = OWNER) => legacy(app, "tools/call", { name, arguments: args }, token);
const said = (reply: Reply) => reply.body?.result?.content?.map((part) => part.text).join("\n") ?? "";
const names = (reply: Reply) => ((reply.body?.result?.tools ?? []) as { name: string }[]).map((tool) => tool.name).sort();

describe("Huddle as an MCP server", () => {
  it("opens with initialize for 2025 clients, and answers 2026-07-28 ones without a handshake", async () => {
    const { app } = setup();
    const opened = await legacy(app, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2" } });
    assert.equal(opened.status, 200);
    assert.deepEqual(opened.body?.id, 1);
    assert.equal(opened.body?.result?.protocolVersion, "2025-06-18", "the version it asked for, since Huddle speaks it");
    assert.deepEqual(opened.body?.result?.serverInfo, { name: "huddle", title: "Huddle", version: "test" });
    assert.deepEqual(opened.body?.result?.capabilities, { tools: { listChanged: false } });
    assert.match(String(opened.body?.result?.instructions), /get_run/);
    const older = await legacy(app, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "old", version: "1" } });
    assert.equal(older.body?.result?.protocolVersion, "2025-11-25", "Huddle's latest, for the client to accept or leave");
    const notified = await app.request("/mcp", { method: "POST", headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    assert.deepEqual([notified.status, await notified.text()], [202, ""]);
    assert.deepEqual((await legacy(app, "ping")).body?.result, {});
    for (const method of ["GET", "DELETE"]) {
      const refused = await app.request("/mcp", { method, headers: { authorization: `Bearer ${OWNER}` } });
      assert.deepEqual([refused.status, refused.headers.get("allow")], [405, "POST"], "no sessions, no event stream");
    }

    const discovered = await modern(app, "server/discover");
    assert.equal(discovered.status, 200);
    const result = discovered.body?.result ?? {};
    assert.equal(result.resultType, "complete");
    assert.deepEqual(result.supportedVersions, ["2026-07-28", "2025-11-25", "2025-06-18"]);
    assert.deepEqual(result.capabilities, { tools: { listChanged: false } });
    assert.deepEqual([result.cacheScope, typeof result.ttlMs], ["public", "number"]);
    assert.deepEqual(result._meta, { "io.modelcontextprotocol/serverInfo": { name: "huddle", title: "Huddle", version: "test" } });
  });

  it("lists every flow for you, what a contact may start or ask for, and only the open ones for a stranger", async () => {
    const { app, store } = setup();
    store.saveFlow(greeter);
    store.saveFlow({ ...invoices, callers: { starts: "family", others: "refuse", strangers: "refuse" } });
    const friend = store.addContact({ name: "Asha", tier: "friend" });

    assert.deepEqual(names(await legacy(app, "tools/list")), ["flow_greeter", "flow_invoices", "get_run"]);
    assert.deepEqual(names(await legacy(app, "tools/list", {}, friend.token)), ["flow_greeter", "get_run"], "greeter asks the owner first; invoices turns friends away");
    const tool = ((await legacy(app, "tools/list")).body?.result?.tools as { name: string; title: string; description: string; inputSchema: object }[]).find((one) => one.name === "flow_greeter");
    assert.deepEqual(tool, {
      name: "flow_greeter",
      title: "Greeter",
      description: "Says hello.",
      inputSchema: { type: "object", properties: { input: { type: "string", description: "What to send the flow; its steps read it as {{input}}." } }, required: ["input"], additionalProperties: false },
    });
    const forFriend = ((await legacy(app, "tools/list", {}, friend.token)).body?.result?.tools as { name: string; description: string }[]).find((one) => one.name === "flow_greeter");
    assert.match(forFriend?.description ?? "", /The owner approves each request first/);

    // Strangers: nothing at all while no flow lets them ask, as on A2A.
    for (const token of [null, "wrong-token", "hdl_c_made-up"]) assert.equal((await legacy(app, "initialize", { protocolVersion: "2025-11-25" }, token)).status, 401);
    const desk = store.saveFlow({ ...greeter, name: "Front desk", callers: { starts: "owner", others: "ask", strangers: "ask" } });
    assert.deepEqual(names(await legacy(app, "tools/list", {}, null)), ["flow_front_desk"], "no get_run: a stranger has no runs to read");
    for (const name of ["flow_greeter", "get_run", "flow_nothing_here"]) assert.equal((await call(app, name, { input: "Hi", run_id: "run_1" }, null)).status, 401, name);
    const asked = await call(app, "flow_front_desk", { input: "Can we talk Tuesday?" }, null);
    assert.match(said(asked), /^Waiting for the owner's approval: Someone not in your contacts wants to run "Front desk" with: Can we talk Tuesday\?$/);
    assert.equal(store.runs(1, desk.id)[0]?.state, "waiting");
  });

  it("runs a flow and answers with what it said, noting in the run that it came over MCP", async () => {
    const { app, store } = setup();
    store.saveFlow(greeter);
    const reply = await call(app, "flow_greeter", { input: "Ada" });
    assert.deepEqual(reply.body?.result, { content: [{ type: "text", text: "Hello from Huddle." }] });
    const run = store.runs(1)[0]!;
    assert.deepEqual(store.logOf(run.id)[0]?.detail, { name: "You", tier: "owner", via: "mcp" });
    assert.deepEqual(store.logOf(run.id).find((line) => line.kind === "asked")?.detail, { assistant: "host", ask: "Greet: Ada", memory: [] });

    // The same over 2026-07-28: the result says it's complete and who answered.
    const now = await modern(app, "tools/call", { name: "flow_greeter", arguments: { input: "Ada" } });
    assert.deepEqual(now.body?.result, { resultType: "complete", content: [{ type: "text", text: "Hello from Huddle." }], _meta: { "io.modelcontextprotocol/serverInfo": { name: "huddle", title: "Huddle", version: "test" } } });
    const listed = await modern(app, "tools/list");
    assert.deepEqual([listed.body?.result?.cacheScope, listed.body?.result?.ttlMs], ["private", 60_000], "each caller sees their own list");

    const noInput = await call(app, "flow_greeter", { text: "Ada" });
    assert.deepEqual([noInput.body?.result?.isError, said(noInput)], [true, "Send what the flow should work on as text in input."]);
  });

  it("comes back waiting with the run id when a run stops for your approval, and get_run follows it to the end", async () => {
    const { app, store, engine } = setup();
    store.saveFlow(invoices);
    const reply = await call(app, "flow_invoices", { input: "Invoice #12" });
    assert.equal(reply.body?.result?.isError, undefined, "waiting isn't an error");
    const runId = /Run id: (run_\w+)/.exec(said(reply))?.[1];
    assert.ok(runId, said(reply));
    assert.match(said(reply), /^Waiting for the owner's approval: Pay Northwind 450\?\nAnswer it in Huddle: http:\/\/huddle\.test\/#\/approvals\nRun id: run_\w+\. Ask get_run/);
    assert.match(said(await call(app, "get_run", { run_id: runId })), /^Waiting for the owner's approval: Pay Northwind 450\?/);

    await engine.decide(store.waitingApproval(runId)!.id, true);
    assert.equal(said(await call(app, "get_run", { run_id: runId })), "Reminder added.");
    const gone = await call(app, "get_run", { run_id: "run_nope" });
    assert.deepEqual([gone.body?.result?.isError, said(gone)], [true, 'There\'s no run "run_nope" started here.']);
  });

  it("answers still running after its wait, and says when a run failed or you said no", async () => {
    let release = () => {};
    const slow: Connector = { send: () => new Promise((resolve) => (release = () => resolve({ text: "Finally." }))) };
    const store = new Store();
    const engine = new Engine(store, { mock, http: slow });
    const app = createApp({ store, engine, version: "test", publicUrl: "http://huddle.test", a2aToken: OWNER, mcpWaitMs: 20 });
    store.saveFlow(parseFlow({ name: "Slow", assistants: [{ id: "s", connector: "http", url: "http://slow.test" }], steps: [{ id: "think", type: "agent", agent: "s", ask: "{{input}}" }] }));
    store.saveFlow(parseFlow({ name: "Broken", assistants: [{ id: "b", connector: "openai", url: "http://nowhere.test" }], steps: [{ id: "try", type: "agent", agent: "b", ask: "{{input}}" }] }));
    store.saveFlow(invoices);

    const running = await call(app, "flow_slow", { input: "think hard" });
    assert.match(said(running), /^Still running\.\nRun id: run_\w+\./);
    release();
    const runId = /Run id: (run_\w+)/.exec(said(running))?.[1] ?? "";
    for (let tries = 0; store.run(runId)?.state === "running" && tries < 100; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(said(await call(app, "get_run", { run_id: runId })), "Finally.");

    const broken = await call(app, "flow_broken", { input: "x" });
    assert.deepEqual([broken.body?.result?.isError, said(broken)], [true, 'The run failed: There\'s no "openai" connector set up for "b".']);

    const waiting = await call(app, "flow_invoices", { input: "Invoice #13" });
    const invoiceRun = /Run id: (run_\w+)/.exec(said(waiting))?.[1] ?? "";
    await engine.decide(store.waitingApproval(invoiceRun)!.id, false);
    assert.equal(said(await call(app, "get_run", { run_id: invoiceRun })), "The owner declined this.");
  });

  it("asks contacts' runs first or turns them away, by each flow's callers rule", async () => {
    const { app, store } = setup();
    store.saveFlow({ ...greeter, callers: { starts: "friend", others: "ask", strangers: "refuse" } });
    store.saveFlow({ ...invoices, callers: { starts: "family", others: "refuse", strangers: "refuse" } });
    const asha = store.addContact({ name: "Asha", tier: "friend" });
    const ravi = store.addContact({ name: "Ravi", tier: "contact" });

    assert.equal(said(await call(app, "flow_greeter", { input: "Ada" }, asha.token)), "Hello from Huddle.");
    const asked = await call(app, "flow_greeter", { input: "Ada" }, ravi.token);
    assert.match(said(asked), /^Waiting for the owner's approval: Ravi \(contact\) wants to run "Greeter" with: Ada\nRun id: run_\w+\. Ask get_run/);
    assert.doesNotMatch(said(asked), /#\/approvals/, "only you get the link to Approvals");
    const runId = /Run id: (run_\w+)/.exec(said(asked))?.[1] ?? "";
    assert.deepEqual(store.logOf(runId)[0]?.detail, { name: "Ravi", tier: "contact", via: "mcp" });

    const refused = await call(app, "flow_invoices", { input: "Invoice #12" }, asha.token);
    assert.deepEqual([refused.status, refused.body?.result?.isError, said(refused)], [200, true, '"Invoices" takes requests only from family and closer.']);
    assert.equal(store.runs(10).length, 2, "nothing started for the refusal");
  });

  it("asks your assistants through the router, and only you", async () => {
    const store = new Store();
    const engine = new Engine(store, { mock });
    const app = createApp({ store, engine, version: "test", publicUrl: "http://huddle.test", a2aToken: OWNER, router: new Router(store, engine) });
    store.saveAssistants([
      Assistant.parse({ id: "local", name: "Local", description: "small talk", connector: "mock", replies: { "*": "Local model here." } }),
      Assistant.parse({ id: "hermes", connector: "mock", replies: { cat: "Your cat is Miso." } }),
    ]);
    const friend = store.addContact({ name: "Asha", tier: "friend" });

    const tools = (await legacy(app, "tools/list")).body?.result?.tools as { name: string; description: string; inputSchema: { properties: { assistant: { enum?: string[] } } } }[];
    assert.deepEqual(tools.map((tool) => tool.name), ["get_run", "ask_assistant", "list_assistants"]);
    const ask = tools.find((tool) => tool.name === "ask_assistant");
    assert.deepEqual(ask?.inputSchema.properties.assistant.enum, ["auto", "local", "hermes"]);
    assert.match(ask?.description ?? "", /local \(small talk\); hermes/);

    assert.equal(said(await call(app, "ask_assistant", { assistant: "hermes", message: "What's my cat called?" })), "Your cat is Miso.\n\n(Answered by hermes.)");
    assert.equal(said(await call(app, "ask_assistant", { assistant: "auto", message: "hi" })), "Local model here.\n\n(Answered by Local.)", "no judge: the list's order");
    assert.ok(store.runs(10).some((run) => run.flow.name === "Router: Local"), "the call shows in Runs");
    const nobody = await call(app, "ask_assistant", { assistant: "nobody", message: "hi" });
    assert.deepEqual([nobody.body?.result?.isError, said(nobody)], [true, 'There\'s no assistant "nobody". Yours: local, hermes.']);
    assert.match(said(await call(app, "list_assistants", {})), /^- auto: Huddle picks the one that fits \(no judge set up, so the list's order\)\n- local: Local, through mock\. small talk\n- hermes: hermes, through mock$/);

    assert.deepEqual(names(await legacy(app, "tools/list", {}, friend.token)), ["get_run"], "assistants act for you, so contacts don't see them");
    const notYours = await call(app, "ask_assistant", { assistant: "local", message: "hi" }, friend.token);
    assert.deepEqual([notYours.body?.error?.code, notYours.body?.error?.message], [-32602, 'There\'s no tool "ask_assistant".']);
  });

  it("lets each contact read only the runs they started, and you all the ones started over MCP", async () => {
    const { app, store, engine } = setup();
    store.saveFlow({ ...greeter, callers: { starts: "friend", others: "ask", strangers: "refuse" } });
    const asha = store.addContact({ name: "Asha", tier: "friend" });
    const mum = store.addContact({ name: "Mum", tier: "family" });

    await call(app, "flow_greeter", { input: "from Asha" }, asha.token);
    const ashas = store.runs(1)[0]!.id;
    const read = (runId: string, token: string) => call(app, "get_run", { run_id: runId }, token);
    assert.equal(said(await read(ashas, asha.token)), "Hello from Huddle.");
    assert.equal(said(await read(ashas, mum.token)), `There's no run "${ashas}" started here.`, "Mum didn't start it");
    assert.equal(said(await read(ashas, OWNER)), "Hello from Huddle.");

    const local = await engine.start(greeter, "not over MCP");
    assert.equal((await read(local.id, OWNER)).body?.result?.isError, true, "runs started elsewhere aren't MCP's to show");
  });

  it("answers bad requests the way MCP says", async () => {
    const { app, store } = setup();
    store.saveFlow(greeter);
    const raw = async (body: string, headers: Record<string, string> = {}) => {
      const response = await app.request("/mcp", { method: "POST", headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", ...headers }, body });
      return { status: response.status, body: (await response.json()) as { id?: unknown; error?: { code: number; message: string; data?: unknown } } };
    };
    assert.deepEqual([(await raw("{nope")).status, (await raw("{nope")).body.error?.code], [400, -32700]);
    const batch = await raw(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]));
    assert.deepEqual([batch.status, batch.body.error?.code], [400, -32600]);
    assert.match(batch.body.error?.message ?? "", /no batches/);
    assert.equal((await raw(JSON.stringify({ id: 1, method: "ping" }))).body.error?.code, -32600, "not JSON-RPC 2.0");
    assert.equal((await raw(JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" }))).body.error?.code, -32600, "an id that's null");
    const unknown = await legacy(app, "resources/list");
    assert.deepEqual([unknown.status, unknown.body?.error?.code, unknown.body?.id], [200, -32601, 1]);
    const noTool = await legacy(app, "tools/call", { name: "flow_nothing", arguments: {} });
    assert.deepEqual([noTool.body?.error?.code, noTool.body?.error?.message], [-32602, 'There\'s no tool "flow_nothing".']);
    assert.equal((await legacy(app, "tools/list", {}, OWNER, { "mcp-protocol-version": "1999-01-01" })).status, 400);
    assert.equal((await legacy(app, "tools/list", {}, OWNER, { origin: "https://evil.example" })).status, 403, "DNS rebinding: a page from elsewhere");
    assert.equal((await legacy(app, "tools/list", {}, OWNER, { origin: "http://localhost:6274" })).status, 200, "a page on this machine, like the MCP Inspector");

    // 2026-07-28: headers that must match the body, its version, and 404 for a method it doesn't do.
    const missing = await modern(app, "tools/list", {}, OWNER, { "mcp-protocol-version": "" });
    assert.deepEqual([missing.status, missing.body?.error?.code], [400, -32020]);
    const method = await modern(app, "tools/list", {}, OWNER, { "mcp-method": "tools/call" });
    assert.deepEqual([method.status, method.body?.error?.code], [400, -32020]);
    const name = await modern(app, "tools/call", { name: "flow_greeter", arguments: { input: "Ada" } }, OWNER, { "mcp-name": "get_run" });
    assert.deepEqual([name.status, name.body?.error?.code], [400, -32020]);
    const encoded = await modern(app, "tools/call", { name: "flow_greeter", arguments: { input: "Ada" } }, OWNER, { "mcp-name": `=?base64?${Buffer.from("flow_greeter").toString("base64")}?=` });
    assert.equal(said(encoded), "Hello from Huddle.");
    const future = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", "mcp-protocol-version": "2099-01-01", "mcp-method": "tools/list" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2099-01-01", "io.modelcontextprotocol/clientCapabilities": {} } } }),
    });
    assert.equal(future.status, 400);
    assert.deepEqual((await future.json()).error, { code: -32022, message: "Unsupported protocol version", data: { supported: ["2026-07-28", "2025-11-25", "2025-06-18"], requested: "2099-01-01" } });
    const pinged = await modern(app, "ping");
    assert.deepEqual([pinged.status, pinged.body?.error?.code], [404, -32601], "ping is gone in 2026-07-28");
    const noCapabilities = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", "mcp-protocol-version": MODERN, "mcp-method": "tools/list" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } } }),
    });
    assert.deepEqual([noCapabilities.status, (await noCapabilities.json()).error.code], [400, -32602]);
  });

  it("names each flow's tool after it, uniquely, and the canvas shows it", async () => {
    const flow = (id: string, name: string, createdAt: string): SavedFlow => ({ id, flow: { ...greeter, name }, webhookSecret: "s", createdAt, updatedAt: createdAt });
    const named = toolNames([
      flow("flow_bbbbbbbbbbbb", "Plan a walk", "2026-10-02T00:00:00.000Z"),
      flow("flow_aaaaaaaaaaaa", "Plan a walk!", "2026-10-01T00:00:00.000Z"),
      flow("flow_cccccccccccc", "Crème brûlée — orders", "2026-10-03T00:00:00.000Z"),
      flow("flow_dddddddddddd", "日本語", "2026-10-04T00:00:00.000Z"),
      flow("flow_eeeeeeeeeeee", "A very long flow name that keeps going and going", "2026-10-05T00:00:00.000Z"),
    ]);
    assert.deepEqual(Object.fromEntries(named), {
      flow_aaaaaaaaaaaa: "flow_plan_a_walk",
      flow_bbbbbbbbbbbb: "flow_plan_a_walk_bbbbbbbbbbbb",
      flow_cccccccccccc: "flow_creme_brulee_orders",
      flow_dddddddddddd: "flow_dddddddddddd",
      flow_eeeeeeeeeeee: "flow_a_very_long_flow_name_that_keeps",
    });
    for (const name of named.values()) assert.match(name, /^[a-z0-9_]{1,51}$/, "fits Claude's 64 characters with mcp__huddle__ in front");

    const { app, store } = setup({ token: OWNER });
    const saved = store.saveFlow(greeter);
    const auth = { authorization: `Bearer ${OWNER}` };
    assert.equal((await (await app.request(`/api/flows/${saved.id}`, { headers: auth })).json()).mcpTool, "flow_greeter");
    assert.deepEqual((await (await app.request("/api/info")).json()).mcp, { url: "http://huddle.test/mcp", token: "HUDDLE_A2A_TOKEN" });
  });

  it("is everyone's owner on a Huddle with no token, as A2A is", async () => {
    const { app, store } = setup({ a2aToken: undefined });
    store.saveFlow(greeter);
    assert.equal(said(await call(app, "flow_greeter", { input: "Ada" }, null)), "Hello from Huddle.");
    assert.deepEqual((await (await app.request("/api/info")).json()).mcp, { url: "http://huddle.test/mcp", token: null });
  });
});
