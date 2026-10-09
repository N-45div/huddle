/**
 * The shapes the server's /api sends and takes. The web app imports these (types only), so the two
 * can't drift apart. All routes are under /api; when the server has a token, every call carries
 * `Authorization: Bearer <token>` (the event stream takes `?token=` instead).
 */
import type { Flow, LogLine, Note, RunState, RunView, Trigger } from "@huddle/core";

export type { Flow, LogLine, Note, RunState, RunView, Trigger };

/** GET /api/info: what this Huddle can do. */
export interface Info {
  readonly version: string;
  /** Whether calls need the token. */
  readonly auth: boolean;
  /** Where other assistants find Huddle over A2A. */
  readonly agentCard: string;
  /** Whether "describe it" is set up (an AI model is configured). */
  readonly describe: boolean;
  /** Whether an OpenShell gateway is set up, for sandboxed assistants and their requests. */
  readonly openshell: boolean;
  /** The router's OpenAI-compatible base URL (model = an assistant's id), when it's on. */
  readonly router: string | null;
}

/** One saved flow, as the list and the editor see it. */
export interface FlowView {
  readonly id: string;
  readonly flow: Flow;
  /** POST here to run it (shown only for webhook flows, but always valid). */
  readonly webhookUrl: string;
  /** Where another assistant starts it over A2A (with the A2A token), whatever its trigger. */
  readonly a2aUrl: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RunSummary {
  readonly id: string;
  readonly flowId: string | null;
  readonly flowName: string;
  readonly state: RunState;
  readonly at: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** GET /api/runs/:id */
export interface RunDetail {
  readonly run: RunView;
  readonly flow: Flow;
  readonly log: readonly LogLine[];
}

/** GET /api/approvals: what's waiting on a person. */
export interface WaitingApproval {
  readonly id: string;
  readonly runId: string;
  readonly stepId: string;
  readonly flowName: string;
  readonly message: string;
  readonly createdAt: string;
}

/** A field an assistant of this connector needs, for the "add assistant" form. */
export interface ConnectorField {
  readonly key: "url" | "keyEnv" | "model" | "agentId" | "audience" | "command" | "replies";
  readonly label: string;
  readonly required: boolean;
  readonly placeholder?: string;
  /** "models": the server can list the choices (GET /api/connectors/:id/models?url=). */
  readonly suggest?: "models";
}

/** GET /api/connectors */
export interface ConnectorInfo {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly fields: readonly ConnectorField[];
}

/** Every 4xx/5xx body. `problems` lists what's wrong with a flow, one line each. */
export interface ApiError {
  readonly error: string;
  readonly problems?: readonly string[];
}

/** One event on GET /api/events (Server-Sent Events, event name "change"). */
export type ChangeEvent =
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "approval"; readonly runId: string }
  | { readonly kind: "memory" }
  | { readonly kind: "flow"; readonly flowId: string }
  | { readonly kind: "sandbox" };

/** A network rule an OpenShell sandbox needs, drafted by OpenShell after it blocked a connection. */
export interface SandboxRequestView {
  readonly sandbox: string;
  readonly id: string;
  /** host:port pairs it would allow. */
  readonly endpoints: readonly string[];
  /** The program in the sandbox that tried to connect. */
  readonly binary: string;
  readonly rationale: string;
  /** OpenShell's risk notes; empty when it found nothing to flag. */
  readonly securityNotes: string;
  /** The policy prover's verdict, e.g. "no new findings". */
  readonly validation: string;
  readonly hits: number;
  readonly firstSeen: string | null;
}

/** GET /api/sandbox-requests */
export interface SandboxRequests {
  /** Whether Huddle is set up with an OpenShell gateway (HUDDLE_OPENSHELL_GATEWAY). */
  readonly configured: boolean;
  /** Whether the last look at the gateway worked; `error` says why not. */
  readonly connected: boolean;
  readonly error: string | null;
  readonly requests: readonly SandboxRequestView[];
}

/*
 * Routes:
 *   GET    /api/info                       -> Info
 *   GET    /api/connectors                 -> ConnectorInfo[]
 *   GET    /api/assistants                 -> Assistant[]          (your assistants, for the router)
 *   PUT    /api/assistants { assistants }  -> Assistant[]          (replaces the list; 400 ApiError with problems)
 *   GET    /api/connectors/:id/models?url= -> { models: string[] }  (Ollama; 502 ApiError when it can't be reached)
 *   GET    /api/flows                      -> FlowView[]
 *   POST   /api/flows        { flow }      -> FlowView            (400 ApiError with problems)
 *   POST   /api/flows/check  { flow }      -> { ok: true } | ApiError
 *   GET    /api/flows/:id                  -> FlowView
 *   PUT    /api/flows/:id    { flow }      -> FlowView
 *   DELETE /api/flows/:id                  -> { ok: true }
 *   POST   /api/flows/:id/run { input? }   -> 202 { runId }       (the run continues in the background)
 *   POST   /api/flows/:id/webhook/rotate   -> FlowView            (a new secret address)
 *   GET    /api/runs?flow=&limit=          -> RunSummary[]
 *   GET    /api/runs/:id                   -> RunDetail
 *   GET    /api/approvals                  -> WaitingApproval[]
 *   POST   /api/approvals/:id { yes }      -> 202 { runId }
 *   GET    /api/memory?status=             -> Note[]
 *   POST   /api/memory { slice, note }     -> Note                (a person's own note: kept)
 *   POST   /api/memory/:id/keep            -> { ok: true }
 *   DELETE /api/memory/:id                 -> { ok: true }
 *   POST   /api/describe { text }          -> { flow }            (501 when no model is set up)
 *   GET    /api/sandbox-requests           -> SandboxRequests
 *   POST   /api/sandbox-requests/:sandbox/:id { yes, reason? } -> { ok: true }   (409 when it changed meanwhile)
 *   GET    /api/pact                       -> { issuer, jwksUri, kid }   (Huddle as a PACT personal agent)
 *   POST   /api/pact/register { provider, name } -> { registered, audience }   (reference-style self-service)
 *   GET    /api/events?token=              -> SSE of ChangeEvent
 * Outside /api:
 *   POST   /hooks/:flowId/:secret          -> 202 { runId }       (body: text, or JSON { input })
 *   GET    /.well-known/agent-card.json    -> Huddle's A2A Agent Card
 *   GET    /.well-known/jwks.json, /.well-known/openid-configuration   -> Huddle's PACT signing key
 *   POST   /a2a                            -> A2A 1.0 JSON-RPC (SendMessage, GetTask)
 *   GET    /v1/models, POST /v1/chat/completions   -> the router, OpenAI-compatible (model = assistant id;
 *                                                     `models: [...]` for fallbacks; stream supported)
 *   GET    /a2a/flows/:id/.well-known/agent-card.json, POST /a2a/flows/:id   -> one flow as its own A2A agent
 */
