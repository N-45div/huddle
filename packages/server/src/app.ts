import { Assistants, type Change, type Engine, Flow, type Note, ollamaModels, type PactIdentity, type Router, type SavedFlow, type Store } from "@huddle/core";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { a2aRoutes } from "./a2a.ts";
import { routerRoutes } from "./router.ts";
import { bearerOf, same } from "./auth.ts";
import type { ApiError, FlowView, Info, RunDetail, RunSummary, WaitingApproval } from "./api-types.ts";
import { CONNECTORS } from "./connectors-info.ts";
import { noSandboxes, type SandboxInbox, Stale } from "./sandbox-requests.ts";

/**
 * Huddle's server: the API the canvas uses (/api), webhooks that start flows (/hooks), and an A2A
 * endpoint so other assistants can hand work to a flow (/a2a). One token, when set, guards it all
 * (the A2A endpoint can have its own). Static files for the web app are added by main.ts.
 */

export interface AppOptions {
  readonly store: Store;
  readonly engine: Engine;
  readonly version: string;
  /** Where Huddle is reached from outside, for webhook and A2A addresses. */
  readonly publicUrl: string;
  /** When set, every /api call needs it as a Bearer token. */
  readonly token?: string;
  /** The token other assistants use on /a2a; defaults to `token`. */
  readonly a2aToken?: string;
  /** Drafts a flow from a sentence, when an AI model is set up. */
  readonly describe?: (text: string) => Promise<Flow>;
  /** How long an A2A message waits for its run before answering "still working" (default 100 s). */
  readonly a2aWaitMs?: number;
  /** For reaching other servers (listing a connector's models); tests pass a stand-in. */
  readonly fetcher?: typeof fetch;
  /** What OpenShell sandboxes are asking for, when an OpenShell gateway is set up. */
  readonly sandboxes?: SandboxInbox;
  /** Huddle's identity as a PACT personal agent: its key is published at /.well-known/jwks.json. */
  readonly pact?: PactIdentity;
  /** The router: your assistants by id behind an OpenAI-compatible /v1. */
  readonly router?: Router;
  /** A key just for /v1 (HUDDLE_ROUTER_KEY), besides the Huddle token. */
  readonly routerKey?: string;
}

/** A flow from a request body, or the problems with it, one line each. */
export function checkFlow(input: unknown): { flow: Flow } | { problems: string[] } {
  const result = Flow.safeParse(input);
  if (result.success) return { flow: result.data };
  return { problems: result.error.issues.map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message)) };
}

const bad = (c: Context, error: string, status: 400 | 401 | 404 | 409 | 501 | 502 = 400, problems?: string[]) => c.json<ApiError>(problems ? { error, problems } : { error }, status);

async function body(c: Context): Promise<Record<string, unknown>> {
  return ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
}

export function createApp(options: AppOptions): Hono {
  const { store, engine } = options;
  const app = new Hono();
  const view = (saved: SavedFlow): FlowView => ({
    id: saved.id,
    flow: saved.flow,
    webhookUrl: `${options.publicUrl}/hooks/${saved.id}/${saved.webhookSecret}`,
    a2aUrl: `${options.publicUrl}/a2a/flows/${saved.id}`,
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt,
  });

  app.use("/api/*", async (c, next) => {
    // /api/info is open: it holds nothing private, and it's how the canvas learns it needs to ask for the token.
    if (!options.token || c.req.path === "/api/info") return next();
    const bearer = bearerOf(c.req.header("authorization"));
    // EventSource can't send headers, so the event stream takes the token in the query.
    const queried = c.req.path === "/api/events" ? c.req.query("token") : undefined;
    if (same(bearer, options.token) || same(queried, options.token)) return next();
    return bad(c, "Send the Huddle token as Authorization: Bearer <token>.", 401);
  });

  const sandboxes = options.sandboxes ?? noSandboxes;
  app.get("/api/info", (c) =>
    c.json<Info>({ version: options.version, auth: Boolean(options.token), agentCard: `${options.publicUrl}/.well-known/agent-card.json`, describe: Boolean(options.describe), openshell: Boolean(options.sandboxes), router: options.router ? `${options.publicUrl}/v1` : null }),
  );

  // What OpenShell sandboxes are asking for -----------------------------------------------------------
  app.get("/api/sandbox-requests", (c) => c.json(sandboxes.view()));
  app.post("/api/sandbox-requests/:sandbox/:id", async (c) => {
    const { yes, reason } = await body(c);
    if (typeof yes !== "boolean") return bad(c, 'Send { "yes": true } or { "yes": false }.');
    try {
      await sandboxes.decide(c.req.param("sandbox"), c.req.param("id"), yes, typeof reason === "string" ? reason.slice(0, 500) : undefined);
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof Stale) return bad(c, error.message, 409);
      return bad(c, error instanceof Error ? error.message : String(error), 502);
    }
  });
  app.get("/api/connectors", (c) => c.json(CONNECTORS));

  // Your assistants, set up once: what the router reaches by id ---------------------------------------
  app.get("/api/assistants", (c) => c.json(store.assistants()));
  app.put("/api/assistants", async (c) => {
    const result = Assistants.safeParse((await body(c)).assistants);
    if (!result.success) return bad(c, "These assistants have problems.", 400, result.error.issues.map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message)));
    store.saveAssistants(result.data);
    return c.json(store.assistants());
  });
  app.get("/api/connectors/:id/models", async (c) => {
    if (c.req.param("id") !== "ollama") return bad(c, "This connector doesn't list models.", 404);
    const url = c.req.query("url")?.trim() || undefined;
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) return bad(c, "The address should start with http:// or https://.");
    try {
      return c.json({ models: await ollamaModels(url, options.fetcher) });
    } catch (error) {
      return bad(c, error instanceof Error ? error.message : String(error), 502);
    }
  });

  // Flows -----------------------------------------------------------------------------------------
  app.get("/api/flows", (c) => c.json(store.flows().map(view)));
  app.post("/api/flows/check", async (c) => {
    const checked = checkFlow((await body(c)).flow);
    return "problems" in checked ? bad(c, "This flow has problems.", 400, checked.problems) : c.json({ ok: true });
  });
  app.post("/api/flows", async (c) => {
    const checked = checkFlow((await body(c)).flow);
    if ("problems" in checked) return bad(c, "This flow has problems.", 400, checked.problems);
    return c.json(view(store.saveFlow(checked.flow)), 201);
  });
  app.get("/api/flows/:id", (c) => {
    const saved = store.flow(c.req.param("id"));
    return saved ? c.json(view(saved)) : bad(c, "There's no such flow.", 404);
  });
  app.put("/api/flows/:id", async (c) => {
    if (!store.flow(c.req.param("id"))) return bad(c, "There's no such flow.", 404);
    const checked = checkFlow((await body(c)).flow);
    if ("problems" in checked) return bad(c, "This flow has problems.", 400, checked.problems);
    return c.json(view(store.saveFlow(checked.flow, c.req.param("id"))));
  });
  app.delete("/api/flows/:id", (c) => (store.deleteFlow(c.req.param("id")) ? c.json({ ok: true }) : bad(c, "There's no such flow.", 404)));
  app.post("/api/flows/:id/run", async (c) => {
    const saved = store.flow(c.req.param("id"));
    if (!saved) return bad(c, "There's no such flow.", 404);
    const input = (await body(c)).input;
    return c.json({ runId: engine.launch(saved.flow, typeof input === "string" ? input : "", saved.id) }, 202);
  });
  app.post("/api/flows/:id/webhook/rotate", (c) => {
    if (!store.flow(c.req.param("id"))) return bad(c, "There's no such flow.", 404);
    return c.json(view(store.rotateWebhook(c.req.param("id"))));
  });

  // Runs and approvals ------------------------------------------------------------------------------
  app.get("/api/runs", (c) => {
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
    const runs = store.runs(limit, c.req.query("flow") || undefined);
    return c.json<RunSummary[]>(runs.map((run) => ({ id: run.id, flowId: run.flowId, flowName: run.flow.name, state: run.state, at: run.at, error: run.error, createdAt: run.createdAt, updatedAt: run.updatedAt })));
  });
  app.get("/api/runs/:id", (c) => {
    const run = store.run(c.req.param("id"));
    if (!run) return bad(c, "There's no such run.", 404);
    return c.json<RunDetail>({ run: engine.view(run.id), flow: run.flow, log: store.logOf(run.id) });
  });
  app.get("/api/approvals", (c) =>
    c.json<WaitingApproval[]>(
      store.waitingApprovals().map((approval) => ({ id: approval.id, runId: approval.runId, stepId: approval.stepId, flowName: store.run(approval.runId)?.flow.name ?? "", message: approval.message, createdAt: approval.createdAt })),
    ),
  );
  app.post("/api/approvals/:id", async (c) => {
    const yes = (await body(c)).yes;
    if (typeof yes !== "boolean") return bad(c, 'Send { "yes": true } or { "yes": false }.');
    try {
      return c.json({ runId: engine.answer(c.req.param("id"), yes) }, 202);
    } catch (error) {
      return bad(c, error instanceof Error ? error.message : String(error), 409);
    }
  });

  // Memory ----------------------------------------------------------------------------------------
  app.get("/api/memory", (c) => {
    const status = c.req.query("status");
    return c.json<Note[]>(store.notes(status === "kept" || status === "suggested" ? status : undefined));
  });
  app.post("/api/memory", async (c) => {
    const { slice, note } = await body(c);
    if (typeof slice !== "string" || !slice.trim() || typeof note !== "string" || !note.trim()) return bad(c, "A note needs a slice and some text.");
    return c.json(store.remember(slice.trim(), note.trim()), 201);
  });
  app.post("/api/memory/:id/keep", (c) => (store.keep(c.req.param("id")) ? c.json({ ok: true }) : bad(c, "There's no such suggestion.", 404)));
  app.delete("/api/memory/:id", (c) => (store.forget(c.req.param("id")) ? c.json({ ok: true }) : bad(c, "There's no such note.", 404)));

  // Describe it -------------------------------------------------------------------------------------
  app.post("/api/describe", async (c) => {
    if (!options.describe) return bad(c, "Describe it needs an AI model: set HUDDLE_LLM_URL and HUDDLE_LLM_MODEL (and HUDDLE_LLM_KEY if it needs one).", 501);
    const text = (await body(c)).text;
    if (typeof text !== "string" || !text.trim()) return bad(c, "Describe the flow in a sentence.");
    try {
      return c.json({ flow: await options.describe(text.trim()) });
    } catch (error) {
      return bad(c, error instanceof Error ? error.message : String(error));
    }
  });

  // Live changes --------------------------------------------------------------------------------------
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const send = (change: Change) => void stream.writeSSE({ event: "change", data: JSON.stringify(change) });
      store.events.on("change", send);
      const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }), 25_000).unref();
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(ping);
      store.events.off("change", send);
    }),
  );

  // Webhooks ----------------------------------------------------------------------------------------
  app.post("/hooks/:flowId/:secret", async (c) => {
    const saved = store.flow(c.req.param("flowId"));
    if (!saved || !same(c.req.param("secret"), saved.webhookSecret)) return bad(c, "There's no such webhook.", 404);
    const type = c.req.header("content-type") ?? "";
    let input = "";
    if (type.includes("json")) {
      const json = (await c.req.json().catch(() => null)) as { input?: unknown } | null;
      input = typeof json?.input === "string" ? json.input : JSON.stringify(json ?? {});
    } else {
      input = await c.req.text();
    }
    return c.json({ runId: engine.launch(saved.flow, input.slice(0, 100_000), saved.id) }, 202);
  });

  // PACT: Huddle's public key, so businesses can check the requests it signs -------------------------
  const pact = options.pact;
  if (pact) {
    app.get("/.well-known/jwks.json", (c) => c.json(pact.jwks(), 200, { "cache-control": "public, max-age=300" }));
    // Open Providers find the key through OIDC discovery under the issuer.
    app.get("/.well-known/openid-configuration", (c) => c.json({ issuer: pact.issuer, jwks_uri: pact.jwksUri }));
  }
  app.get("/api/pact", (c) => (pact ? c.json({ issuer: pact.issuer, jwksUri: pact.jwksUri, kid: pact.publicJwk().kid }) : bad(c, "PACT isn't set up on this Huddle.", 404)));
  /**
   * Registers Huddle with a Provider that offers self-service registration the way PACT's reference
   * Provider does (POST {provider}/api/platforms, a token signed with Huddle's key). Others register by hand.
   */
  app.post("/api/pact/register", async (c) => {
    if (!pact) return bad(c, "PACT isn't set up on this Huddle.", 404);
    const { provider, name } = await body(c);
    if (typeof provider !== "string" || !/^https?:\/\/\S+$/i.test(provider.trim())) return bad(c, "Give the Provider's address, starting with http:// or https://.");
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{1,62}$/i.test(name.trim())) return bad(c, "Give Huddle a name for this Provider: letters, numbers and dashes.");
    const endpoint = `${provider.trim().replace(/\/+$/, "")}/api/platforms`;
    let response: Response;
    try {
      response = await (options.fetcher ?? fetch)(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${pact.sign({ aud: endpoint, sub: pact.issuer })}`, "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), jwksUri: pact.jwksUri }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return bad(c, `Can't reach ${endpoint}.`, 502);
    }
    const said = (await response.json().catch(() => null)) as { error?: unknown; message?: unknown; audience?: unknown } | null;
    if (response.status === 201 || response.ok) return c.json({ registered: true, audience: typeof said?.audience === "string" ? said.audience : null });
    if (response.status === 409) return bad(c, "This Provider already has that name or Huddle's issuer registered. If it's Huddle's, you're set.", 409);
    const detail = typeof said?.error === "string" ? said.error : typeof said?.message === "string" ? said.message : `HTTP ${response.status}`;
    return bad(c, `The Provider turned the registration down: ${detail}.`, 502);
  });

  if (options.router) app.route("/", routerRoutes({ store, router: options.router, keys: [options.routerKey, options.token].filter((key): key is string => Boolean(key)) }));
  app.route("/", a2aRoutes(options));
  return app;
}
