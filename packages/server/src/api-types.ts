/**
 * The shapes the server's /api sends and takes. The web app imports these (types only), so the two
 * can't drift apart. All routes are under /api; when the server has a token, every call carries
 * `Authorization: Bearer <token>` (the event stream takes `?token=` instead).
 */
import type { Assistant, Choice, Contact, HeldBy, ContactTier, Flow, LogLine, MemoryHit, Note, RunState, RunView, SignIn, Trigger, View } from "@huddle/core";

export type { Assistant, Choice, Contact, HeldBy, ContactTier, Flow, LogLine, MemoryHit, Note, RunState, RunView, SignIn, Trigger, View };
export type { FoundTool, ToolDetails } from "./monid.ts";

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
  /**
   * Huddle as an MCP server: its address, and the environment variable holding the token a client
   * sends to act as you (null when this Huddle has no token, on this machine only).
   */
  readonly mcp: { readonly url: string; readonly token: "HUDDLE_A2A_TOKEN" | "HUDDLE_TOKEN" | null };
  /**
   * Email in: where Resend's inbound webhook posts (one address for every flow), and whether Huddle
   * can take it (RESEND_WEBHOOK_SECRET and RESEND_API_KEY are set).
   */
  readonly email: { readonly hook: string; readonly receiving: boolean };
  /** What checks each hand-off before it's made (e.g. "ArmorIQ"), when something does. */
  readonly guard: string | null;
  /** Showing answers as views: who chooses the view ("jev", "model", "rules"), and the model that fills charts and the like in, if any. */
  readonly present: { readonly chooser: string; readonly writer: string | null };
}

/** POST /api/present: how to show an answer, and the view. */
export interface PresentedView {
  readonly choice: Choice;
  readonly view: View;
}

/** One saved flow, as the list and the editor see it. */
export interface FlowView {
  readonly id: string;
  readonly flow: Flow;
  /** POST here to run it (shown only for webhook flows, but always valid). */
  readonly webhookUrl: string;
  /** Where another assistant starts it over A2A (with the A2A token), whatever its trigger. */
  readonly a2aUrl: string;
  /** The tool that starts it over MCP (flow_ and its name), for whoever its callers rule lets in. */
  readonly mcpTool: string;
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
  /** Held by a guard's own approver (ArmorIQ): approve it there; a no here still stops it. */
  readonly heldBy: HeldBy | null;
}

/** How one assistant has done through the router lately (from its runs). */
export interface RouterUsage {
  readonly assistant: string;
  readonly calls: number;
  readonly failures: number;
  /** Average time to answer, for the calls that answered. */
  readonly averageMs: number | null;
  readonly lastAt: string | null;
  /** Dollars its router calls cost this period, for the calls with a known cost. */
  readonly spentUsd: number;
  /** Calls whose cost is unknown: no price given and none reported. */
  readonly unpriced: number;
  /** Calls whose tokens were guessed from the text. */
  readonly estimated: number;
  /** Calls answered from a kept answer this period. */
  readonly reused: number;
}

/** What hand-offs cost this period (a month, or the budget's period), and what the router saved. */
export interface SpendView {
  readonly period: "day" | "month";
  readonly since: string;
  /** Every hand-off with a known cost, flows and router alike: what the budget counts. */
  readonly spentUsd: number;
  readonly budgetUsd: number | null;
  /** Of that, through the router. */
  readonly routerUsd: number;
  /** Router calls answered from a kept answer, and what they'd have cost. */
  readonly reused: number;
  readonly savedByReuseUsd: number;
  /** Router calls that went to a cheaper assistant than the judge's first choice, and what that saved. */
  readonly cheaper: number;
  readonly savedByCheaperUsd: number;
}

/** GET /api/router */
export interface RouterView {
  readonly on: boolean;
  /** The OpenAI-compatible base URL. */
  readonly baseUrl: string;
  /** Who judges model "auto": "jev", "model", or null (your list's order). */
  readonly judge: string | null;
  /** Whether calls need a key (the Huddle token or HUDDLE_ROUTER_KEY). */
  readonly keyRequired: boolean;
  readonly usage: readonly RouterUsage[];
  readonly spend: SpendView;
}

/** A field an assistant of this connector needs, for the "add assistant" form. */
export interface ConnectorField {
  readonly key: "url" | "keyEnv" | "model" | "agentId" | "audience" | "command" | "replies" | "scopes" | "to" | "from" | "tool" | "input" | "maxUsd" | "waitSeconds";
  readonly label: string;
  readonly required: boolean;
  readonly placeholder?: string;
  /** "models": the server can list the choices (GET /api/connectors/:id/models?url=). */
  readonly suggest?: "models";
  /** The only values it takes, to pick from. */
  readonly choices?: readonly { readonly value: string; readonly label: string }[];
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
  | { readonly kind: "sandbox" }
  | { readonly kind: "assistants" }
  | { readonly kind: "contacts" }
  | { readonly kind: "signin" };

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
 *   GET    /api/router                     -> RouterView           (address, judge, usage per assistant)
 *   GET    /api/signins                    -> SignIn[]             (PACT sign-ins waiting for you)
 *   POST   /api/signins/:id/check          -> { ok }               (you signed in: ask the business now)
 *   POST   /api/signins/:id/cancel         -> { ok }               (the step that needed it fails)
 *   GET    /api/contacts                   -> Contact[]
 *   POST   /api/contacts { name, tier, emails? } -> { contact, token }   (the token is shown this once)
 *   PATCH  /api/contacts/:id { name?, tier?, emails? } -> Contact
 *   POST   /api/contacts/:id/token         -> { token }            (a new token; the old one stops working)
 *   DELETE /api/contacts/:id               -> 204
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
 *   GET    /api/memory/search?q=&slice=&status=&limit= -> MemoryHit[]   (best first; slice may repeat)
 *   POST   /api/memory { slice, note }     -> Note                (a person's own note: kept; 400 if it holds a secret)
 *   POST   /api/memory/:id/keep            -> { ok: true }        (400 if it holds a secret)
 *   DELETE /api/memory/:id                 -> { ok: true }
 *   POST   /api/describe { text }          -> { flow }            (501 when no model is set up)
 *   GET    /api/sandbox-requests           -> SandboxRequests
 *   POST   /api/sandbox-requests/:sandbox/:id { yes, reason? } -> { ok: true }   (409 when it changed meanwhile)
 *   GET    /api/pact                       -> { issuer, jwksUri, kid }   (Huddle as a PACT personal agent)
 *   POST   /api/pact/register { provider, name } -> { registered, audience }   (reference-style self-service)
 *   GET    /api/events?token=              -> SSE of ChangeEvent
 * Outside /api:
 *   POST   /hooks/:flowId/:secret          -> 202 { runId }       (body: text, or JSON { input })
 *   POST   /hooks/email                    -> { started: runId[] } (Resend's email.received event, Svix-signed;
 *                                                     starts the flows whose email trigger is an address it went to)
 *   GET    /.well-known/agent-card.json    -> Huddle's A2A Agent Card
 *   GET    /.well-known/jwks.json, /.well-known/openid-configuration   -> Huddle's PACT signing key
 *   POST   /a2a                            -> A2A 1.0 JSON-RPC (SendMessage, GetTask)
 *   GET    /v1/models, POST /v1/chat/completions   -> the router, OpenAI-compatible (model = assistant id;
 *                                                     `models: [...]` for fallbacks; stream supported)
 *   GET    /a2a/flows/:id/.well-known/agent-card.json, POST /a2a/flows/:id   -> one flow as its own A2A agent
 *   POST   /mcp                            -> MCP over Streamable HTTP, no sessions (2026-07-28, and
 *                                                     2025-11-25 / 2025-06-18 through initialize): a tool per flow,
 *                                                     get_run, and for the owner ask_assistant and list_assistants
 */
