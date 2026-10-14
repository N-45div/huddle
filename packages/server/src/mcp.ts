import { AUTO, type Caller, callerDecision, NoAnswer, type Run, type SavedFlow } from "@huddle/core";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppOptions } from "./app.ts";
import { answerOf, callerKey, callerOf, mayRead, refusal, settled, startFor } from "./callers.ts";
import type { MonidCatalog } from "./monid.ts";

/**
 * Huddle as an MCP server (https://modelcontextprotocol.io), so Claude Code, Claude Desktop, Cursor or
 * any MCP client can run your flows and ask your assistants. /mcp is Streamable HTTP without sessions:
 * one JSON-RPC request per POST, answered with plain JSON. It speaks both eras of MCP: the current
 * revision (2026-07-28), where every request carries its version in _meta, and the earlier ones that
 * open with initialize (2025-11-25, 2025-06-18), which most clients still send.
 *
 * The tools: one per flow this caller may start (flow_ and its name), get_run to follow a run, and for
 * you only, ask_assistant and list_assistants through the router, and with MONID_API_KEY set,
 * monid_find, monid_show and monid_run for Monid's paid data tools (each run checked and kept in Runs). Callers are told apart as on A2A
 * (your token, a contact's own token, or a stranger), and each flow's callers rule applies.
 */

/** The revision where each request says its version, and the earlier ones that open with initialize. */
const MODERN = ["2026-07-28"];
const LEGACY = ["2025-11-25", "2025-06-18"];
const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";

// JSON-RPC error codes: the standard ones and MCP's.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_VERSION = -32022;

type Json = Record<string, unknown>;

class RpcError extends Error {
  readonly code: number;
  /** The HTTP status it goes back with. */
  readonly status: 200 | 400 | 404;
  readonly data: unknown;
  constructor(code: number, message: string, status: 200 | 400 | 404 = 200, data?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

/** Thrown for a stranger reaching for what isn't open to strangers: a 401, as on A2A. */
const UNAUTHORIZED = Symbol("unauthorized");

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Each flow's tool name, the same for every caller: flow_ and its name in lowercase words. A flow named
 * like an older one adds its id, so names stay unique; renaming a flow renames its tool.
 */
export function toolNames(flows: readonly SavedFlow[]): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  const oldestFirst = flows.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const saved of oldestFirst) {
    const words = saved.flow.name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+/, "")
      .slice(0, 32)
      .replace(/_+$/, "");
    const hex = saved.id.replace(/^flow_/, "");
    let name = `flow_${words || hex}`;
    if (used.has(name)) name = `flow_${words}_${hex}`;
    used.add(name);
    names.set(saved.id, name);
  }
  return names;
}

/** An MCP Mcp-Name header's value, decoded when it's sent as =?base64?…?=. */
function headerValue(value: string | undefined): string | undefined {
  const encoded = value === undefined ? null : /^=\?base64\?(.*)\?=$/.exec(value);
  return encoded ? Buffer.from(encoded[1] ?? "", "base64").toString("utf8") : value;
}

const text = (said: string, isError = false) => ({ content: [{ type: "text", text: said }], ...(isError ? { isError: true } : {}) });

/** The owner's Monid tools: find a paid data tool, read what it takes, run it within the spend cap. */
function monidTools(maxUsd: number): Json[] {
  return [
    {
      name: "monid_find",
      title: "Find a data tool",
      description: "Searches Monid's catalog of paid data tools (job listings, reviews, prices, search results, SEO numbers) for a need described in words. Lists each tool's id and price; free to call.",
      inputSchema: { type: "object", properties: { need: { type: "string", description: 'What the tool should do, like "Google job listings by keyword and location".' } }, required: ["need"], additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    {
      name: "monid_show",
      title: "Read a data tool",
      description: "What one of Monid's tools does, costs and takes: its input fields, and an input to start from for monid_run. Free to call.",
      inputSchema: { type: "object", properties: { tool: { type: "string", description: 'The tool as provider/endpoint, like "dataforseo/serp/google-jobs".' } }, required: ["tool"], additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    {
      name: "monid_run",
      title: "Run a data tool",
      description: `Runs one of Monid's paid tools with an input and answers with its output. Huddle checks it first: it may cost up to $${maxUsd} a run, Huddle's budget must have room, and tools that scrape sites whose terms forbid it, find personal contact details or contact people never run. The run and what it cost show in Huddle's Runs.`,
      inputSchema: {
        type: "object",
        properties: {
          tool: { type: "string", description: "The tool as provider/endpoint." },
          input: { type: "object", description: 'Its input, grouped as monid_show says, like { "body": { "keyword": "nurse", "location_name": "India", "language_code": "en" } }.' },
        },
        required: ["tool", "input"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    {
      name: "monid_result",
      title: "Pick up a data tool's result",
      description: "The output of a monid_run that was still working when it answered: give the Monid run id it named. Free to call.",
      inputSchema: { type: "object", properties: { run: { type: "string", description: "The Monid run id monid_run answered with." } }, required: ["run"], additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
  ];
}

export function mcpRoutes(options: AppOptions): Hono {
  const { store, engine, router } = options;
  const token = options.a2aToken ?? options.token;
  // Under the 60 s that MCP SDK clients wait by default, so the run id gets back before they give up.
  const waitMs = options.mcpWaitMs ?? 50_000;
  const serverInfo = { name: "huddle", title: "Huddle", version: options.version };
  const capabilities = { tools: { listChanged: false } };
  const instructions = `Huddle runs its owner's flows: assistants handing work to each other, with approvals and shared memory. Each flow_ tool starts one flow with your input and waits up to ${Math.round(waitMs / 1000)} seconds for its answer. A run that stops for the owner's approval, or takes longer, comes back with its run id: check it later with get_run. The owner answers approvals in Huddle, not here. With the owner's token, ask_assistant asks one of the owner's assistants directly.`;
  const publicOrigin = URL.canParse(options.publicUrl) ? new URL(options.publicUrl).origin : null;
  // Which runs were started over MCP, and by whom: only these are runs a caller may read with get_run.
  store.db.exec("CREATE TABLE IF NOT EXISTS mcp_runs (run_id TEXT PRIMARY KEY, caller TEXT NOT NULL, created_at TEXT NOT NULL)");
  const app = new Hono();

  /** A browser page may call only from this Huddle's own address or this machine, so DNS rebinding gets nowhere. */
  const fromHere = (origin: string): boolean => {
    if (origin === publicOrigin) return true;
    try {
      return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname);
    } catch {
      return false;
    }
  };
  const openToStrangers = () => store.flows().some((saved) => callerDecision(saved.flow.callers, "stranger") !== "refuse");
  /** Every flow with its tool name and what its callers rule says to this caller, oldest first so the list keeps its order. */
  const flowsFor = (caller: Caller) => {
    const flows = store.flows();
    const names = toolNames(flows);
    return flows
      .map((saved) => ({ name: names.get(saved.id) ?? saved.id, saved, decision: callerDecision(saved.flow.callers, caller.tier) }))
      .sort((a, b) => a.saved.createdAt.localeCompare(b.saved.createdAt) || a.saved.id.localeCompare(b.saved.id));
  };

  const toolsFor = (caller: Caller): Json[] => {
    const flows = flowsFor(caller)
      .filter((flow) => flow.decision !== "refuse")
      .map(({ name, saved, decision }) => ({
        name,
        title: saved.flow.name,
        description: `${saved.flow.description?.trim() || `Runs the "${saved.flow.name}" flow.`}${decision === "ask" ? " The owner approves each request first, so it comes back waiting." : ""}`,
        inputSchema: { type: "object", properties: { input: { type: "string", description: "What to send the flow; its steps read it as {{input}}." } }, required: ["input"], additionalProperties: false },
      }));
    if (caller.tier === "stranger") return flows;
    const getRun = {
      name: "get_run",
      title: "Check a run",
      description: "How a flow run started here stands: its answer once it's done, or what it's waiting for. Give the run id a flow tool answered with.",
      inputSchema: { type: "object", properties: { run_id: { type: "string", description: "The run's id, like run_1a2b3c4d5e6f." } }, required: ["run_id"], additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    };
    const monid = caller.tier === "owner" && options.monid ? monidTools(options.monid.maxUsd) : [];
    if (caller.tier !== "owner" || !router) return [...flows, getRun, ...monid];
    const yours = store.assistants();
    const judged = router.judge ? `judged by ${router.judge.name}` : "no judge set up, so the list's order";
    const listed = yours.map((assistant) => `${assistant.id}${assistant.description ? ` (${assistant.description})` : ""}`).join("; ");
    const ask = {
      name: "ask_assistant",
      title: "Ask an assistant",
      description: `Asks one of the owner's assistants directly through Huddle's router, with only the memory slices it may read; the call shows in Huddle's Runs. Name it by id, or "auto" to let Huddle pick (${judged}).${listed ? ` The assistants: ${listed}.` : " There are no assistants yet."}`,
      inputSchema: {
        type: "object",
        properties: {
          assistant: { type: "string", description: 'The assistant\'s id, or "auto".', ...(yours.length ? { enum: [AUTO, ...yours.map((assistant) => assistant.id)] } : {}) },
          message: { type: "string", description: "What to ask it." },
        },
        required: ["assistant", "message"],
        additionalProperties: false,
      },
    };
    const list = {
      name: "list_assistants",
      title: "List assistants",
      description: "Lists the owner's assistants that ask_assistant reaches: each one's id, name, connector and what it's good at.",
      inputSchema: { type: "object", additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    };
    return [...flows, getRun, ask, list, ...monid];
  };

  /** A run as a tool's answer: what it answered once done; else where it stands, with its id for get_run. */
  const runResult = (run: Run, caller: Caller) => {
    const follow = caller.tier === "stranger" ? "" : `\nRun id: ${run.id}. Ask get_run with it to see how it ends.`;
    switch (run.state) {
      case "done":
        return text(answerOf(store, run).text);
      case "waiting": {
        const waiting = store.waitingApproval(run.id);
        const where = caller.tier === "owner" ? `\nAnswer it in Huddle: ${options.publicUrl}/#/approvals` : "";
        return text(`Waiting for the owner's approval${waiting ? `: ${waiting.message}` : "."}${where}${follow}`);
      }
      case "running":
        return text(`Still running.${follow}`);
      case "declined":
        return text("The owner declined this.");
      case "failed":
        return text(`The run failed: ${run.error ?? "no reason given."}`, true);
    }
  };

  async function callTool(params: Json, caller: Caller) {
    const name = params.name;
    if (typeof name !== "string" || !name) throw new RpcError(INVALID_PARAMS, "Say which tool in name.");
    const args = isObject(params.arguments) ? params.arguments : {};
    const flow = flowsFor(caller).find((candidate) => candidate.name === name);
    if (flow) {
      if (flow.decision === "refuse") {
        // A stranger gets the same answer whether or not the flow exists, as on A2A.
        if (caller.tier === "stranger") throw UNAUTHORIZED;
        return text(refusal(flow.saved), true);
      }
      if (typeof args.input !== "string") return text("Send what the flow should work on as text in input.", true);
      const runId = startFor(engine, flow.saved, args.input, caller, "mcp");
      if (!runId) return text(refusal(flow.saved), true);
      store.db.prepare("INSERT INTO mcp_runs (run_id, caller, created_at) VALUES (?, ?, ?)").run(runId, callerKey(caller), new Date().toISOString());
      await settled(store, runId, waitMs);
      return runResult(store.run(runId)!, caller);
    }
    if (caller.tier === "stranger") throw UNAUTHORIZED;
    if (name === "get_run") {
      const runId = typeof args.run_id === "string" ? args.run_id.trim() : "";
      if (!runId) return text("Give the run's id in run_id.", true);
      const row = store.db.prepare("SELECT caller FROM mcp_runs WHERE run_id = ?").get(runId) as { caller: string } | undefined;
      const run = row && mayRead(row.caller, caller) ? store.run(runId) : null;
      return run ? runResult(run, caller) : text(`There's no run "${runId}" started here.`, true);
    }
    if (caller.tier === "owner" && router && name === "ask_assistant") {
      const assistant = typeof args.assistant === "string" ? args.assistant.trim() : "";
      const message = typeof args.message === "string" ? args.message.trim() : "";
      if (!assistant || !message) return text('Say which assistant (its id, or "auto") and what to ask it.', true);
      try {
        const routed = await router.answer({ model: assistant, ask: message.slice(0, 100_000) });
        return text(`${routed.text}\n\n(Answered by ${routed.assistant.name ?? routed.assistant.id}.)`);
      } catch (error) {
        if (error instanceof NoAnswer) return text(error.message, true);
        throw error;
      }
    }
    if (caller.tier === "owner" && router && name === "list_assistants") {
      const yours = store.assistants();
      if (yours.length === 0) return text("There are no assistants yet: add them on Huddle's Assistants page.");
      const lines = yours.map((assistant) => `- ${assistant.id}: ${assistant.name ?? assistant.id}, through ${assistant.connector}${assistant.description ? `. ${assistant.description}` : ""}`);
      return text([`- ${AUTO}: Huddle picks the one that fits (${router.judge ? `judged by ${router.judge.name}` : "no judge set up, so the list's order"})`, ...lines].join("\n"));
    }
    if (caller.tier === "owner" && options.monid && name.startsWith("monid_")) return monidCall(options.monid, name, args);
    throw new RpcError(INVALID_PARAMS, `There's no tool "${name}".`);
  }

  async function monidCall(catalog: MonidCatalog, name: string, args: Json) {
    try {
      if (name === "monid_find") {
        const need = typeof args.need === "string" ? args.need.trim() : "";
        if (need.length < 2) return text("Say in need what the tool should do.", true);
        const found = await catalog.find(need);
        if (!found.length) return text("Nothing in Monid's catalog fits that; try other words.");
        const lines = found.map((tool) => `- ${tool.tool} (${tool.price}): ${tool.description}${tool.blocked ? ` Huddle won't run it: ${tool.blocked}.` : ""}`);
        return text(`${lines.join("\n")}\n\nRead what one takes with monid_show, then run it with monid_run.`);
      }
      if (name === "monid_show") {
        const id = typeof args.tool === "string" ? args.tool.trim() : "";
        const details = id ? await catalog.show(id) : null;
        if (!details) return text(`Monid has no tool called "${id}". Find one with monid_find.`, true);
        const fields = details.fields.map((field) => `- ${field.group}.${field.name} (${field.required ? "required, " : ""}${field.type})${field.description ? `: ${field.description}` : ""}`);
        return text(
          [
            `${details.tool} (${details.price}): ${details.description}`,
            ...(details.blocked ? [`Huddle won't run it: ${details.blocked}.`] : []),
            "",
            "It takes:",
            ...fields,
            "",
            `An input for monid_run to start from (put real values where it says {{ask}} or <…>): ${JSON.stringify(details.starter)}`,
          ].join("\n"),
        );
      }
      if (name === "monid_run") {
        const id = typeof args.tool === "string" ? args.tool.trim() : "";
        if (!id || !isObject(args.input)) return text("Give the tool (provider/endpoint) and its input as an object, grouped as monid_show says (body, queryParams, pathParams).", true);
        const ran = await catalog.run(engine, id, args.input);
        if (ran.pending) return text(ran.text);
        const cost = ran.costUsd !== null && ran.costUsd > 0 ? `, Monid charged $${Number(ran.costUsd.toPrecision(3))}` : "";
        const where = ran.runId ? `\n\n(Huddle run ${ran.runId}${cost}.)` : "";
        return text(`${ran.text}${where}`, !ran.ok);
      }
      if (name === "monid_result") {
        const run = typeof args.run === "string" ? args.run.trim() : "";
        if (!/^[\w-]{6,80}$/.test(run)) return text("Give the Monid run id monid_run answered with, in run.", true);
        const result = await catalog.result(run);
        const cost = result.costUsd !== null && result.costUsd > 0 ? `\n\n(Monid charged $${Number(result.costUsd.toPrecision(3))}.)` : "";
        return text(`${result.text}${cost}`, !result.ok);
      }
    } catch (error) {
      return text(`Monid didn't answer: ${error instanceof Error ? error.message : String(error)}`, true);
    }
    throw new RpcError(INVALID_PARAMS, `There's no tool "${name}".`);
  }

  /** A request from a client that sends its version in _meta (2026-07-28): checked, then answered without any session. */
  async function modern(c: Context, method: string, params: Json, meta: Json, caller: Caller) {
    const declared = meta[VERSION_KEY];
    const header = c.req.header("mcp-protocol-version");
    if (typeof declared !== "string" || header !== declared) throw new RpcError(HEADER_MISMATCH, `The MCP-Protocol-Version header (${header ?? "missing"}) should match the protocol version in _meta (${String(declared)}).`, 400);
    if (!MODERN.includes(declared)) throw new RpcError(UNSUPPORTED_VERSION, "Unsupported protocol version", 400, { supported: [...MODERN, ...LEGACY], requested: declared });
    if (!isObject(meta[CAPABILITIES_KEY])) throw new RpcError(INVALID_PARAMS, `Every request carries ${CAPABILITIES_KEY} in _meta.`, 400);
    if (c.req.header("mcp-method") !== method) throw new RpcError(HEADER_MISMATCH, `The Mcp-Method header (${c.req.header("mcp-method") ?? "missing"}) should match the method (${method}).`, 400);
    const done = (result: Json, cache?: { readonly ttlMs: number; readonly cacheScope: "public" | "private" }) => ({ resultType: "complete", ...result, ...cache, _meta: { [SERVER_INFO_KEY]: serverInfo } });
    switch (method) {
      case "server/discover":
        return done({ supportedVersions: [...MODERN, ...LEGACY], capabilities, instructions }, { ttlMs: 3_600_000, cacheScope: "public" });
      case "tools/list":
        // Each caller sees their own flows; flows change, and Huddle doesn't send list_changed, so a minute.
        return done({ tools: toolsFor(caller) }, { ttlMs: 60_000, cacheScope: "private" });
      case "tools/call": {
        const named = headerValue(c.req.header("mcp-name"));
        if (named !== params.name) throw new RpcError(HEADER_MISMATCH, `The Mcp-Name header (${named ?? "missing"}) should match the tool's name (${String(params.name)}).`, 400);
        return done(await callTool(params, caller));
      }
      default:
        throw new RpcError(METHOD_NOT_FOUND, `Huddle doesn't do ${method}; it does server/discover, tools/list and tools/call.`, 404);
    }
  }

  /** A request from a client that opened with initialize (2025-11-25, 2025-06-18). Huddle keeps no session for it. */
  async function legacy(c: Context, method: string, params: Json, caller: Caller) {
    const header = c.req.header("mcp-protocol-version");
    if (header && MODERN.includes(header)) throw new RpcError(INVALID_PARAMS, `A ${header} request carries ${VERSION_KEY} and ${CAPABILITIES_KEY} in params._meta.`, 400);
    if (header && !LEGACY.includes(header)) throw new RpcError(UNSUPPORTED_VERSION, "Unsupported protocol version", 400, { supported: [...MODERN, ...LEGACY], requested: header });
    switch (method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return { protocolVersion: LEGACY.includes(asked) ? asked : LEGACY[0], capabilities, serverInfo, instructions };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: toolsFor(caller) };
      case "tools/call":
        return callTool(params, caller);
      case "server/discover":
        throw new RpcError(INVALID_PARAMS, `server/discover carries ${VERSION_KEY} and ${CAPABILITIES_KEY} in params._meta.`, 400);
      default:
        throw new RpcError(METHOD_NOT_FOUND, `Huddle doesn't do ${method}; it does initialize, ping, tools/list and tools/call.`);
    }
  }

  const unauthorized = (c: Context) => c.json({ error: "Send your Huddle token (or the one its owner gave you) as Authorization: Bearer <token>." }, 401, { "www-authenticate": 'Bearer realm="huddle"' });
  const failed = (c: Context, id: string | number | undefined, error: RpcError) =>
    c.json({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), error: { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) } }, error.status);

  // No sessions and no event stream to open: everything is a POST.
  app.on(["GET", "DELETE"], "/mcp", (c) => c.json({ error: "Send MCP messages as POST requests. Huddle keeps no sessions or event streams." }, 405, { allow: "POST" }));

  app.post("/mcp", bodyLimit({ maxSize: 1_000_000, onError: (c) => c.json({ error: "That's too big for an MCP message." }, 413) }), async (c) => {
    const origin = c.req.header("origin");
    if (origin && !fromHere(origin)) return c.json({ jsonrpc: "2.0", error: { code: INVALID_REQUEST, message: `Huddle doesn't take MCP calls from pages on ${origin}.` } }, 403);
    const caller = callerOf(store, token, c.req.header("authorization"));
    // Strangers learn nothing unless a flow lets them ask, as on A2A.
    if (caller.tier === "stranger" && !openToStrangers()) return unauthorized(c);
    let message: unknown;
    try {
      message = JSON.parse(await c.req.text());
    } catch {
      return failed(c, undefined, new RpcError(PARSE_ERROR, "That isn't JSON.", 400));
    }
    if (Array.isArray(message)) return failed(c, undefined, new RpcError(INVALID_REQUEST, "Send one JSON-RPC message per request; MCP has no batches since 2025-06-18.", 400));
    if (!isObject(message) || message.jsonrpc !== "2.0") return failed(c, undefined, new RpcError(INVALID_REQUEST, "Send a JSON-RPC 2.0 message.", 400));
    // A notification (initialized, cancelled), or a response to a request Huddle never sends: nothing to answer.
    const notification = typeof message.method === "string" && message.id === undefined;
    if (notification || (message.method === undefined && ("result" in message || "error" in message))) return c.body(null, 202);
    const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : undefined;
    if (id === undefined || typeof message.method !== "string") return failed(c, id, new RpcError(INVALID_REQUEST, "A request has a method, and an id that's a string or a number.", 400));
    const params = isObject(message.params) ? message.params : {};
    const meta = isObject(params._meta) ? params._meta : {};
    try {
      // initialize opens the earlier era; a version in _meta is the current one.
      const result = message.method !== "initialize" && VERSION_KEY in meta ? await modern(c, message.method, params, meta, caller) : await legacy(c, message.method, params, caller);
      return c.json({ jsonrpc: "2.0", id, result });
    } catch (error) {
      if (error === UNAUTHORIZED) return unauthorized(c);
      return failed(c, id, error instanceof RpcError ? error : new RpcError(INTERNAL_ERROR, error instanceof Error ? error.message : String(error)));
    }
  });

  return app;
}
