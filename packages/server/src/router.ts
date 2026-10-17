import { createHash, randomUUID } from "node:crypto";
import { askFrom, AUTO, type ChatMessage, type Engine, lastSaid, NoAnswer, PREFER, type Prefer, type Presenter, present, type Router, type Store, type ViewWriter } from "@huddle/core";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { bearerOf, same } from "./auth.ts";

/**
 * Huddle's router as an OpenAI-compatible API, so any app or SDK that speaks OpenAI can reach any of
 * your assistants with one key: `model` is the assistant's id, `GET /v1/models` lists them, and
 * `models: [...]` (OpenRouter's field) gives fallbacks in order. Each call still gets only the memory
 * slices that assistant may read, and shows in Runs.
 *
 * Huddle's own options go in a `huddle` object: `prefer` ("quality", "balanced" or "cheapest") says how
 * much fit "auto" may trade for cost, and `reuse: false` (or Cache-Control: no-cache) asks afresh instead
 * of answering from a kept answer, and `present: true` adds `huddle.view`: how best to show the answer (a
 * table, chart, flowchart, calculator or comparison, as checked JSON for your app to draw). `usage` in the answer is the assistant's real token count when it
 * reports one, else an estimate, and `huddle.cost` says which and what it cost.
 */

export interface RouterOptions {
  readonly store: Store;
  readonly router: Router;
  /** Learns from what you say in a chat, when learning is on. */
  readonly engine?: Engine;
  /** Who may call: HUDDLE_ROUTER_KEY or HUDDLE_TOKEN. Neither set (this machine only): anyone local. */
  readonly keys: readonly string[];
  /** For huddle.present: how to show an answer, and a model to fill views in. */
  readonly present?: { readonly presenter: Presenter; readonly writer: ViewWriter | null };
}

/** An error in the shape OpenAI clients read. */
const fail = (c: Context, status: 400 | 401 | 404 | 429 | 502, message: string, code: string) =>
  c.json({ error: { message, type: status === 502 ? "upstream_error" : status === 429 ? "insufficient_quota" : "invalid_request_error", code } }, status);

/**
 * Which conversation a request is part of: its instructions and first message, which a chat client sends
 * again with every turn. A one-message request starts one.
 */
function conversationOf(messages: readonly ChatMessage[], key: string | undefined): string | undefined {
  const text = (message: ChatMessage | undefined) => (typeof message?.content === "string" ? message.content : JSON.stringify(message?.content ?? ""));
  const first = messages.find((message) => message.role === "user");
  if (!first) return undefined;
  const instructions = messages.filter((message) => message.role === "system").map(text).join("\n");
  return createHash("sha256").update(JSON.stringify([key ?? "", instructions, text(first)])).digest("hex");
}

export function routerRoutes(options: RouterOptions): Hono {
  const { store, router } = options;
  const app = new Hono();

  app.use("/v1/*", async (c, next) => {
    if (options.keys.length === 0) return next();
    const given = bearerOf(c.req.header("authorization"));
    if (options.keys.some((key) => same(given, key))) return next();
    return fail(c, 401, "Send your Huddle router key as Authorization: Bearer <key>.", "invalid_api_key");
  });

  app.get("/v1/models", (c) => {
    const yours = store.assistants().map((assistant) => ({ id: assistant.id, object: "model", created: 0, owned_by: "huddle", name: assistant.name ?? assistant.id, connector: assistant.connector, description: assistant.description ?? null }));
    const judged = router.judge ? `judged by ${router.judge.name}` : "your list's order: no judge set up";
    const auto = { id: AUTO, object: "model", created: 0, owned_by: "huddle", name: "Auto", connector: null, description: `Huddle picks the assistant that fits (${judged})` };
    return c.json({ object: "list", data: yours.length ? [auto, ...yours] : [] });
  });

  app.post("/v1/chat/completions", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { model?: unknown; models?: unknown; messages?: unknown; stream?: unknown; huddle?: { prefer?: unknown; reuse?: unknown; present?: unknown } } | null;
    if (!body) return fail(c, 400, "Send a JSON body with model and messages.", "invalid_body");
    const models = Array.isArray(body.models) ? body.models.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
    const model = typeof body.model === "string" && body.model ? body.model : undefined;
    if (!model && models.length === 0) return fail(c, 400, 'Say which assistant in "model" (its id, or "auto"), or several in "models".', "model_required");
    if (!Array.isArray(body.messages) || body.messages.length === 0) return fail(c, 400, 'Send the conversation in "messages".', "messages_required");
    let ask: string;
    try {
      ask = askFrom(body.messages as ChatMessage[]);
    } catch (error) {
      return fail(c, 400, error instanceof Error ? error.message : String(error), "no_user_message");
    }

    const prefer = body.huddle?.prefer;
    if (prefer !== undefined && !PREFER.includes(prefer as Prefer)) return fail(c, 400, `huddle.prefer is one of ${PREFER.join(", ")}.`, "invalid_prefer");
    const reuse = body.huddle?.reuse !== false && !/no-cache|no-store/i.test(c.req.header("cache-control") ?? "");
    const conversation = conversationOf(body.messages as ChatMessage[], bearerOf(c.req.header("authorization")));
    // A later turn: an assistant has answered in this conversation before, so it stays with that one.
    const followUp = (body.messages as ChatMessage[]).some((message) => message.role === "assistant");

    let routed;
    try {
      routed = await router.answer({ model, models, ask, reuse, conversation, followUp, ...(prefer ? { prefer: prefer as Prefer } : {}) });
    } catch (error) {
      if (error instanceof NoAnswer) {
        const unknown = error.tried.every((attempt) => attempt.error.startsWith("There's no assistant"));
        const overBudget = error.tried.some((attempt) => attempt.overBudget) && error.tried.every((attempt) => attempt.overBudget || attempt.error.startsWith("There's no assistant"));
        if (overBudget) return fail(c, 429, error.message, "budget_exceeded");
        return fail(c, unknown ? 404 : 502, error.message, unknown ? "model_not_found" : "assistant_failed");
      }
      throw error;
    }

    // Your last message alone (never the replies) may teach memory something, when learning is on.
    if (!routed.reused) options.engine?.learnFrom(routed.runId, lastSaid(body.messages as ChatMessage[]));

    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const cost = routed.cost;
    const huddle = {
      run: routed.runId,
      assistant: routed.assistant.id,
      data: routed.data,
      skipped: routed.skipped,
      route: routed.route,
      reused: routed.reused,
      cost: cost ? { usd: cost.costUsd, estimated: cost.estimated, cachedTokens: cost.cachedTokens ?? 0 } : null,
    };
    // Shown as a view when asked: a failure to present never loses the answer.
    let presented: { view?: unknown; viewError?: string } = {};
    if (body.huddle?.present === true && options.present) {
      try {
        const { choice, view } = await present({ text: routed.text, ask, assistant: routed.assistant.name ?? routed.assistant.id, ...(routed.data !== null && routed.data !== undefined ? { data: routed.data } : {}) }, options.present);
        presented = { view: { ...view, chosenBy: choice.by } };
      } catch (error) {
        presented = { viewError: error instanceof Error ? error.message : String(error) };
      }
    }
    Object.assign(huddle, presented);
    const usage = { prompt_tokens: cost?.inputTokens ?? 0, completion_tokens: cost?.outputTokens ?? 0, total_tokens: (cost?.inputTokens ?? 0) + (cost?.outputTokens ?? 0) };
    if (body.stream === true) {
      // Assistants answer whole, so the stream is the answer in one piece, then the end.
      return streamSSE(c, async (stream) => {
        const chunk = (delta: object, finish: string | null) => JSON.stringify({ id, object: "chat.completion.chunk", created, model: routed.assistant.id, choices: [{ index: 0, delta, finish_reason: finish }] });
        await stream.writeSSE({ data: chunk({ role: "assistant", content: "" }, null) });
        await stream.writeSSE({ data: chunk({ content: routed.text }, null) });
        await stream.writeSSE({ data: chunk({}, "stop") });
        await stream.writeSSE({ data: "[DONE]" });
      });
    }
    return c.json({
      id,
      object: "chat.completion",
      created,
      model: routed.assistant.id,
      choices: [{ index: 0, message: { role: "assistant", content: routed.text }, finish_reason: "stop" }],
      usage,
      huddle,
    });
  });

  return app;
}
