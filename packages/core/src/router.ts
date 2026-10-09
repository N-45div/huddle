import type { Engine } from "./engine.ts";
import type { Judge, Ranking } from "./judge.ts";
import { type Assistant, parseFlow } from "./schema.ts";
import type { Store } from "./store.ts";

/**
 * The router: one way in to every assistant you run, by its id, the way OpenRouter is one way in to
 * every model. A call goes to the assistant through its connector with the memory slices it may read,
 * and is kept as a run, so it shows in Runs with what went in and out. Given several ids, the router
 * tries them in order and answers with the first that works: a fallback when one is down or busy.
 */

export interface ChatMessage {
  readonly role: string;
  readonly content: string | readonly { readonly type?: string; readonly text?: string }[] | null;
}

/** How a request was routed, for the answer to report. */
export interface RouteInfo extends Ranking {
  /** Set when the judge couldn't rank and the router used your list's order instead. */
  readonly note: string | null;
}

export interface Routed {
  readonly assistant: Assistant;
  /** For model "auto": who judged and how. */
  readonly route: RouteInfo | null;
  readonly text: string;
  readonly data: unknown;
  readonly runId: string;
  /** The ones tried before it that didn't answer, and why. */
  readonly skipped: readonly { readonly id: string; readonly error: string }[];
}

/** None of the assistants asked for could answer. */
export class NoAnswer extends Error {
  readonly tried: readonly { readonly id: string; readonly error: string }[];
  constructor(tried: readonly { readonly id: string; readonly error: string }[]) {
    super(tried.length === 1 ? tried[0]!.error : `None of them answered: ${tried.map((attempt) => `${attempt.id}: ${attempt.error}`).join("; ")}`);
    this.tried = tried;
  }
}

const textOf = (content: ChatMessage["content"]): string =>
  typeof content === "string" ? content : (content ?? []).map((part) => (typeof part.text === "string" ? part.text : "")).join("");

/**
 * What to ask, from a chat: the last thing the person said, with the conversation before it when
 * there is one (chat clients send the whole history each time; most assistants keep their own).
 */
export function askFrom(messages: readonly ChatMessage[]): string {
  const said = messages.map((message) => ({ role: message.role, text: textOf(message.content).trim() })).filter((message) => message.text);
  const lastUser = said.findLastIndex((message) => message.role === "user");
  if (lastUser < 0) throw new Error("Send at least one message from the user.");
  const before = said.slice(0, lastUser);
  if (before.length === 0) return said[lastUser]!.text;
  const label = (role: string) => (role === "assistant" ? "You" : role === "system" ? "Instructions" : "Me");
  return `${before.map((message) => `${label(message.role)}: ${message.text}`).join("\n")}\n\nNow: ${said[lastUser]!.text}`;
}

/** "auto": let the judge pick. */
export const AUTO = "auto";
/** A candidate the judge gives less than this isn't tried. */
const FLOOR = 0.05;
/** At most this many attempts for "auto". */
const MAX_AUTO = 3;

export class Router {
  private readonly store: Store;
  private readonly engine: Engine;
  readonly judge: Judge | null;

  constructor(store: Store, engine: Engine, judge: Judge | null = null) {
    this.store = store;
    this.engine = engine;
    this.judge = judge;
  }

  /**
   * Answers a request: `model` is an assistant's id or "auto"; `models` are fallbacks in order, or for
   * "auto" the assistants it may choose among (else all of yours).
   */
  async answer(request: { readonly model?: string; readonly models?: readonly string[]; readonly ask: string }): Promise<Routed> {
    const models = request.models ?? [];
    if (request.model !== AUTO) return this.ask([...new Set([...(request.model ? [request.model] : []), ...models])], request.ask);
    // "auto" never picks one that sends email: mail goes out when a flow's approval says so, or when you name it.
    const yours = this.store.assistants().filter((assistant) => assistant.connector !== "email");
    const pool = models.length ? yours.filter((assistant) => models.includes(assistant.id)) : yours;
    if (pool.length === 0) throw new NoAnswer([{ id: AUTO, error: "There's no assistant to choose from yet: add some first." }]);
    let route: RouteInfo;
    if (!this.judge) {
      route = { judge: "order", order: pool.map((assistant) => assistant.id).slice(0, MAX_AUTO), probabilities: null, confidence: null, model: null, note: "No judge is set up (TYPESAFE_API_KEY for Jev, or HUDDLE_LLM_*), so your list's order." };
    } else {
      try {
        const ranking = await this.judge.rank(request.ask, pool.map((assistant) => ({ id: assistant.id, description: assistant.description ?? `${assistant.name ?? assistant.id} (${assistant.connector})` })));
        const kept = ranking.probabilities ? ranking.order.filter((id, index) => index === 0 || (ranking.probabilities?.[id] ?? 0) >= FLOOR) : ranking.order;
        route = { ...ranking, order: kept.slice(0, MAX_AUTO), note: null };
      } catch (error) {
        route = { judge: "order", order: pool.map((assistant) => assistant.id).slice(0, MAX_AUTO), probabilities: null, confidence: null, model: null, note: `The judge (${this.judge.name}) failed, so your list's order: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    const routed = await this.ask(route.order, request.ask);
    return { ...routed, route };
  }

  /** Asks the first of `ids` that answers. */
  async ask(ids: readonly string[], ask: string): Promise<Routed> {
    const tried: { id: string; error: string }[] = [];
    for (const id of ids) {
      const assistant = this.store.assistant(id);
      if (!assistant) {
        tried.push({ id, error: `There's no assistant "${id}". Yours: ${this.store.assistants().map((one) => one.id).join(", ") || "none yet"}.` });
        continue;
      }
      const flow = parseFlow({
        name: `Router: ${assistant.name ?? assistant.id}`,
        assistants: [assistant],
        steps: [{ id: "reply", type: "agent", agent: assistant.id, ask: "{{input}}" }],
      });
      const view = await this.engine.start(flow, ask);
      const reply = view.context.steps.reply;
      if (view.state === "done" && reply) return { assistant, route: null, text: reply.text, data: reply.data ?? null, runId: view.id, skipped: tried };
      tried.push({ id, error: view.error ?? `The run ended ${view.state}.` });
    }
    throw new NoAnswer(tried);
  }
}
