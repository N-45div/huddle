import { randomUUID } from "node:crypto";
import { type Caller, callerDecision, type Run, type RunState, type SavedFlow } from "@huddle/core";
import { type Context, Hono } from "hono";
import type { AppOptions } from "./app.ts";
import { answerOf, callerKey, callerOf, mayRead, refusal, settled, startFor } from "./callers.ts";

/**
 * Huddle as an A2A 1.0 agent (https://a2a-protocol.org), so OpenClaw, Hermes or any other assistant
 * can hand work to a flow. The Agent Card lists the saved flows as skills; SendMessage starts one (the
 * flow named in the message's metadata as "flow" or "skill", or the only saved flow) and GetTask
 * follows it. A task is a run: its id is the run's id.
 *
 * Each flow is also an agent of its own at /a2a/flows/<id>, with its own card. That's the address to
 * give an assistant that can't add metadata to a message: Hermes' a2a_call and OpenClaw's outbound peers
 * both send plain text to a URL, so the URL has to say which flow.
 *
 * A run waiting on an approval stays TASK_STATE_WORKING, because the person who owns this Huddle has
 * to answer, not the agent that called. Messages wait for the run (A2A's default) until it finishes,
 * stops at an approval, or `a2aWaitMs` passes; returnImmediately: true answers at once.
 */

const STATE: Readonly<Record<RunState, string>> = {
  running: "TASK_STATE_WORKING",
  waiting: "TASK_STATE_WORKING",
  done: "TASK_STATE_COMPLETED",
  declined: "TASK_STATE_REJECTED",
  failed: "TASK_STATE_FAILED",
};

// JSON-RPC error codes: the standard ones and A2A's.
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const TASK_NOT_FOUND = -32001;
/** A caller this flow doesn't take requests from (A2A's range for app errors). */
const NOT_ALLOWED = -32007;

interface Part {
  readonly text?: unknown;
  readonly data?: unknown;
}

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export function a2aRoutes(options: AppOptions & { readonly a2aWaitMs?: number }): Hono {
  const { store, engine } = options;
  const token = options.a2aToken ?? options.token;
  const waitMs = options.a2aWaitMs ?? 100_000;
  // Which runs were started over A2A, and their A2A context: only these are tasks a caller may read.
  store.db.exec("CREATE TABLE IF NOT EXISTS a2a_tasks (run_id TEXT PRIMARY KEY, context_id TEXT NOT NULL, created_at TEXT NOT NULL)");
  // Who started each task ("owner", a contact's id, or "stranger"): a contact reads only their own.
  if (!(store.db.prepare("PRAGMA table_info(a2a_tasks)").all() as { name: string }[]).some((column) => column.name === "caller")) {
    store.db.exec("ALTER TABLE a2a_tasks ADD COLUMN caller TEXT NOT NULL DEFAULT 'owner'");
  }
  const app = new Hono();

  /** The task's A2A context, if this caller may read it: you read every task, others only their own. */
  const contextOf = (runId: string, caller: Caller): string | null => {
    const row = store.db.prepare("SELECT context_id, caller FROM a2a_tasks WHERE run_id = ?").get(runId) as { context_id: string; caller: string } | undefined;
    if (!row || !mayRead(row.caller, caller)) return null;
    return row.context_id;
  };

  const taskOf = (run: Run, contextId: string) => {
    const waiting = run.state === "waiting" ? store.waitingApproval(run.id) : null;
    const said = run.state === "failed" ? run.error : run.state === "declined" ? "The owner declined this." : waiting ? `Waiting for the owner's approval: ${waiting.message}` : null;
    const answer = run.state === "done" ? answerOf(store, run) : null;
    return {
      id: run.id,
      contextId,
      status: {
        state: STATE[run.state],
        ...(said ? { message: { messageId: randomUUID(), role: "ROLE_AGENT", parts: [{ text: said }] } } : {}),
        timestamp: run.updatedAt,
      },
      ...(answer ? { artifacts: [{ artifactId: "result", name: "result", parts: [{ text: answer.text }, ...(answer.data === undefined ? [] : [{ data: answer.data }])] }] } : {}),
      metadata: { flow: run.flowId, flowName: run.flow.name },
    };
  };

  const flowFor = (metadata: Record<string, unknown> | undefined, fixed: SavedFlow | null): SavedFlow => {
    if (fixed) return fixed;
    const wanted = metadata?.flow ?? metadata?.skill;
    const flows = store.flows();
    if (typeof wanted === "string" && wanted) {
      const found = flows.find((saved) => saved.id === wanted) ?? flows.find((saved) => saved.flow.name.toLowerCase() === wanted.toLowerCase());
      if (!found) throw new RpcError(INVALID_PARAMS, `There's no flow "${wanted}". Flows: ${flows.map((saved) => `${saved.id} (${saved.flow.name})`).join(", ") || "none yet"}.`);
      return found;
    }
    if (flows.length === 1) return flows[0]!;
    throw new RpcError(INVALID_PARAMS, flows.length ? `Say which flow in the message's metadata as "flow". Flows: ${flows.map((saved) => `${saved.id} (${saved.flow.name})`).join(", ")}.` : "This Huddle has no saved flows yet.");
  };

  const methods: Readonly<Record<string, (params: Record<string, unknown>, fixed: SavedFlow | null, caller: Caller) => Promise<unknown>>> = {
    async SendMessage(params, fixed, caller) {
      const message = params.message as { parts?: Part[]; contextId?: unknown; taskId?: unknown; metadata?: Record<string, unknown> } | undefined;
      if (!message || !Array.isArray(message.parts)) throw new RpcError(INVALID_PARAMS, "SendMessage needs a message with parts.");
      if (message.taskId) throw new RpcError(INVALID_PARAMS, "Huddle's tasks don't take follow-up messages; send a new message to start a new run.");
      const saved = flowFor({ ...(params.metadata as Record<string, unknown> | undefined), ...message.metadata }, fixed);
      const input = message.parts
        .map((part) => (typeof part.text === "string" ? part.text : part.data !== undefined ? JSON.stringify(part.data) : ""))
        .filter(Boolean)
        .join("\n");
      // Who may start this flow (its callers rule): closer tiers start it, the rest wait for your OK or are turned away.
      const runId = startFor(engine, saved, input, caller, "a2a");
      if (!runId) throw new RpcError(NOT_ALLOWED, refusal(saved));
      const contextId = typeof message.contextId === "string" && message.contextId ? message.contextId : randomUUID();
      store.db.prepare("INSERT INTO a2a_tasks (run_id, context_id, created_at, caller) VALUES (?, ?, ?, ?)").run(runId, contextId, new Date().toISOString(), callerKey(caller));
      const configuration = params.configuration as { returnImmediately?: unknown } | undefined;
      if (configuration?.returnImmediately !== true) await settled(store, runId, waitMs);
      return { task: taskOf(store.run(runId)!, contextId) };
    },
    async GetTask(params, _fixed, caller) {
      const id = typeof params.id === "string" ? params.id : "";
      const contextId = id ? contextOf(id, caller) : null;
      const run = contextId ? store.run(id) : null;
      if (!run || !contextId) throw new RpcError(TASK_NOT_FOUND, `There's no task ${id}.`);
      return taskOf(run, contextId);
    },
  };

  const skillOf = (saved: SavedFlow) => ({ id: saved.id, name: saved.flow.name, description: saved.flow.description ?? `Runs the "${saved.flow.name}" flow.`, tags: ["huddle", saved.flow.trigger.type] });
  const card = (name: string, description: string, path: string, skills: readonly object[]) => ({
    name,
    description,
    version: options.version,
    supportedInterfaces: [{ url: `${options.publicUrl}${path}`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    provider: { organization: "Huddle", url: "https://github.com/N-45div/huddle" },
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills,
    ...(token ? { securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } } }, securityRequirements: [{ schemes: { bearer: { list: [] } } }] } : {}),
  });
  const unauthorized = (c: Context) => c.json({ error: "Send your Huddle token (or the one its owner gave you) as Authorization: Bearer <token>." }, 401);

  app.get("/.well-known/agent-card.json", (c) => {
    // With a token, the public card doesn't name the flows; a caller learns them from a SendMessage.
    const skills = token
      ? [{ id: "flow", name: "Run a flow", description: 'Runs one of this Huddle\'s flows. Name it in the message metadata as "flow".', tags: ["huddle"] }]
      : store.flows().map(skillOf);
    return c.json(card("Huddle", "Hands work between personal assistants along flows their owner drew, with approvals and shared memory.", "/a2a", skills));
  });

  app.get("/a2a/flows/:flowId/.well-known/agent-card.json", (c) => {
    const saved = store.flow(c.req.param("flowId"));
    if (!saved) return c.json({ error: "There's no such flow." }, 404);
    return c.json(card(saved.flow.name, saved.flow.description ?? `A Huddle flow: ${saved.flow.name}.`, `/a2a/flows/${saved.id}`, [skillOf(saved)]));
  });

  app.post("/a2a/flows/:flowId", (c) => {
    const caller = callerOf(store, token, c.req.header("authorization"));
    const saved = store.flow(c.req.param("flowId"));
    // A stranger gets the same answer whether or not the flow exists, unless it lets strangers ask.
    if (caller.tier === "stranger" && (!saved || callerDecision(saved.flow.callers, "stranger") === "refuse")) return unauthorized(c);
    if (!saved) return c.json({ error: "There's no such flow." }, 404);
    return rpc(c, saved, caller);
  });

  // The whole Huddle lists its flows, so it's for you and your contacts only.
  app.post("/a2a", (c) => {
    const caller = callerOf(store, token, c.req.header("authorization"));
    return caller.tier === "stranger" ? unauthorized(c) : rpc(c, null, caller);
  });

  /** One JSON-RPC request, to the whole Huddle or (fixed) to one flow. */
  async function rpc(c: Context, fixed: SavedFlow | null, caller: Caller) {
    const request = (await c.req.json().catch(() => null)) as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown } | null;
    const id = request && (typeof request.id === "string" || typeof request.id === "number") ? request.id : null;
    const reply = (body: object) => c.json({ jsonrpc: "2.0", id, ...body });
    if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") return reply({ error: { code: INVALID_REQUEST, message: "Send a JSON-RPC 2.0 request." } });
    const method = methods[request.method];
    if (!method) return reply({ error: { code: METHOD_NOT_FOUND, message: `Huddle doesn't do ${request.method}; it does ${Object.keys(methods).join(" and ")}.` } });
    try {
      return reply({ result: await method((request.params ?? {}) as Record<string, unknown>, fixed, caller) });
    } catch (error) {
      const code = error instanceof RpcError ? error.code : -32603;
      return reply({ error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  }

  return app;
}
