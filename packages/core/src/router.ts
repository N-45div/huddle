import { createHash } from "node:crypto";
import { budgetName, costOf, dollars, estimateTokens, priceOf, type Spend } from "./cost.ts";
import type { Engine } from "./engine.ts";
import type { Judge, Ranking } from "./judge.ts";
import { type Assistant, parseFlow } from "./schema.ts";
import type { Store } from "./store.ts";

/**
 * The router: one way in to every assistant you run, by its id, the way OpenRouter is one way in to
 * every model. A call goes to the assistant through its connector with the memory slices it may read,
 * and is kept as a run, so it shows in Runs with what went in and out. Given several ids, the router
 * tries them in order and answers with the first that works: a fallback when one is down or busy.
 *
 * It keeps costs down four ways. With "auto", among the assistants that fit nearly as well as the best,
 * the cheaper goes first. A conversation stays with the assistant that started it for a while, which
 * skips the judge and keeps that assistant's prompt cache warm. An assistant can let the very same ask be
 * answered again from its last answer. And past 80% of the budget, "auto" goes for the cheapest.
 */

export interface ChatMessage {
  readonly role: string;
  readonly content: string | readonly { readonly type?: string; readonly text?: string }[] | null;
}

/** How much fit to trade for cost: "quality" takes the judge's order as it is. */
export type Prefer = "quality" | "balanced" | "cheapest";
export const PREFER: readonly Prefer[] = ["quality", "balanced", "cheapest"];

/**
 * An assistant within this share of the best fit counts as fitting nearly as well, so its lower cost may
 * put it first: "balanced" takes any the judge gives at least 60% of the top one's probability.
 */
export const FIT: Readonly<Record<Prefer, number>> = { quality: 1, balanced: 0.6, cheapest: 0.25 };

/** How cost changed the order, for the answer to report. */
export interface CostRoute {
  readonly prefer: Prefer;
  readonly fit: number;
  /** The judge's first choice. */
  readonly top: string;
  /** What a call to each candidate is expected to cost, in dollars: null when unknown. */
  readonly estimates: Readonly<Record<string, number | null>>;
  /** A cheaper assistant went first. */
  readonly reordered: boolean;
}

/** How a request was routed, for the answer to report. */
export interface RouteInfo extends Ranking {
  /** Set when the judge couldn't rank and the router used your list's order instead, and the like. */
  readonly note: string | null;
  readonly cost: CostRoute | null;
}

export interface RouteRequest {
  readonly model?: string;
  readonly models?: readonly string[];
  readonly ask: string;
  /** For "auto" (default "balanced"). */
  readonly prefer?: Prefer;
  /** Names the conversation, so its next turns stay with the same assistant. */
  readonly conversation?: string;
  /** This is a later turn of that conversation (the assistant has answered in it before). */
  readonly followUp?: boolean;
  /** false: don't answer from a kept answer, ask again. */
  readonly reuse?: boolean;
}

export interface Routed {
  readonly assistant: Assistant;
  /** For model "auto": who judged and how. */
  readonly route: RouteInfo | null;
  readonly text: string;
  readonly data: unknown;
  readonly runId: string;
  /** The ones tried before it that didn't answer, and why. */
  readonly skipped: readonly Attempt[];
  /** Answered from a kept answer: nothing was spent, and runId is the run that first answered it. */
  readonly reused: boolean;
  /** What this answer took; null when the run logged none. */
  readonly cost: Spend | null;
}

export interface Attempt {
  readonly id: string;
  readonly error: string;
  /** Skipped because the budget is spent and it costs money. */
  readonly overBudget?: boolean;
}

/** None of the assistants asked for could answer. */
export class NoAnswer extends Error {
  readonly tried: readonly Attempt[];
  constructor(tried: readonly Attempt[]) {
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

/** What the person said last, alone: the words learning may read (never the replies or earlier turns). */
export function lastSaid(messages: readonly ChatMessage[]): string {
  const said = messages.filter((message) => message.role === "user").map((message) => textOf(message.content).trim()).filter(Boolean);
  return said.at(-1) ?? "";
}

/** "auto": let the judge pick. */
export const AUTO = "auto";
/** A candidate the judge gives less than this isn't tried. */
const FLOOR = 0.05;
/** At most this many attempts for "auto". */
const MAX_AUTO = 3;
/** A conversation stays with its assistant this long after its last turn, like providers' prompt caches. */
export const STICKY_MS = 10 * 60_000;
const MAX_STICKY = 1_000;
/** Without history: what an answer runs to, and the kept notes a request carries, in tokens. */
const TYPICAL_OUTPUT_TOKENS = 400;
const TYPICAL_MEMORY_TOKENS = 250;

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const paid = (assistant: Assistant): boolean => {
  const price = priceOf(assistant);
  return Boolean(price && (price.input > 0 || price.output > 0 || price.call > 0));
};

export class Router {
  private readonly store: Store;
  private readonly engine: Engine;
  readonly judge: Judge | null;
  private readonly sticky = new Map<string, { id: string; at: number }>();
  private readonly now: () => number;

  constructor(store: Store, engine: Engine, judge: Judge | null = null, now: () => number = Date.now) {
    this.store = store;
    this.engine = engine;
    this.judge = judge;
    this.now = now;
  }

  /**
   * Answers a request: `model` is an assistant's id or "auto"; `models` are fallbacks in order, or for
   * "auto" the assistants it may choose among (else all of yours).
   */
  async answer(request: RouteRequest): Promise<Routed> {
    const models = request.models ?? [];
    if (request.model !== AUTO) return this.ask([...new Set([...(request.model ? [request.model] : []), ...models])], request.ask, request.reuse);
    // "auto" never picks one that sends email: mail goes out when a flow's approval says so, or when you name it.
    const yours = this.store.assistants().filter((assistant) => assistant.connector !== "email");
    const pool = models.length ? yours.filter((assistant) => models.includes(assistant.id)) : yours;
    if (pool.length === 0) throw new NoAnswer([{ id: AUTO, error: "There's no assistant to choose from yet: add some first." }]);

    // The same conversation goes back to the same assistant: no judge call, and its prompt cache stays warm.
    const stuck = request.conversation && request.followUp ? this.sticky.get(request.conversation) : undefined;
    if (stuck && this.now() - stuck.at < STICKY_MS && pool.some((assistant) => assistant.id === stuck.id)) {
      try {
        const routed = await this.ask([stuck.id], request.ask, request.reuse);
        const route: RouteInfo = { judge: "sticky", order: [stuck.id], probabilities: null, confidence: null, model: null, note: "The same assistant as earlier in this conversation, so no judge call.", cost: null };
        return this.settle(routed, route, request.conversation);
      } catch (error) {
        if (!(error instanceof NoAnswer)) throw error;
        // It's gone quiet: judge afresh.
      }
    }

    let prefer = request.prefer ?? "balanced";
    let pressed: string | null = null;
    const budget = this.engine.budget;
    if (budget && prefer !== "quality") {
      const spent = this.engine.spent();
      if (spent >= budget.usd * 0.8) {
        prefer = "cheapest";
        pressed = `${dollars(spent)} of ${budgetName(budget.period)} ${dollars(budget.usd)} is spent, so the cheapest that fits.`;
      }
    }
    let route: RouteInfo;
    if (!this.judge) {
      route = { judge: "order", order: pool.map((assistant) => assistant.id).slice(0, MAX_AUTO), probabilities: null, confidence: null, model: null, note: "No judge is set up (TYPESAFE_API_KEY for Jev, or HUDDLE_LLM_*), so your list's order.", cost: null };
    } else {
      try {
        const ranking = await this.judge.rank(request.ask, pool.map((assistant) => ({ id: assistant.id, description: assistant.description ?? `${assistant.name ?? assistant.id} (${assistant.connector})` })));
        const { order, cost } = this.byCost(ranking, request.ask, prefer);
        route = { ...ranking, order: order.slice(0, MAX_AUTO), note: pressed, cost };
      } catch (error) {
        route = { judge: "order", order: pool.map((assistant) => assistant.id).slice(0, MAX_AUTO), probabilities: null, confidence: null, model: null, note: `The judge (${this.judge.name}) failed, so your list's order: ${error instanceof Error ? error.message : String(error)}`, cost: null };
      }
    }
    const routed = await this.ask(route.order, request.ask, request.reuse);
    // Going to a cheaper assistant than the judge's first choice saved the difference, as near as it can be known.
    const top = route.cost?.top;
    const expected = top ? route.cost?.estimates[top] : undefined;
    const actual = routed.cost?.costUsd;
    if (!routed.reused && top && routed.assistant.id !== top && typeof expected === "number" && typeof actual === "number" && expected > actual) this.store.savedByCheaperPick(routed.runId, expected - actual);
    return this.settle(routed, route, request.conversation);
  }

  /** Remembers who answered the conversation, and logs how the call was routed. */
  private settle(routed: Routed, route: RouteInfo, conversation: string | undefined): Routed {
    if (conversation) {
      this.sticky.delete(conversation);
      this.sticky.set(conversation, { id: routed.assistant.id, at: this.now() });
      if (this.sticky.size > MAX_STICKY) this.sticky.delete(this.sticky.keys().next().value!);
    }
    if (!routed.reused) this.store.log(routed.runId, "reply", "routed", route);
    return { ...routed, route };
  }

  /**
   * The judge's ranking, with cost in it: of the candidates that fit nearly as well as the best, the
   * cheaper go first (one whose cost is unknown counts as the middle of the known ones, after any that
   * cost the same), then the rest in the judge's order. Without probabilities, the judge's order as it is.
   */
  private byCost(ranking: Ranking, ask: string, prefer: Prefer): { order: string[]; cost: CostRoute | null } {
    const probabilities = ranking.probabilities;
    const kept = probabilities ? ranking.order.filter((id, index) => index === 0 || (probabilities[id] ?? 0) >= FLOOR) : [...ranking.order];
    const top = kept[0];
    if (!probabilities || !top || prefer === "quality") return { order: kept, cost: null };
    const fitOf = (id: string) => probabilities[id] ?? 0;
    const near = kept.filter((id) => fitOf(id) >= Math.max(FLOOR, FIT[prefer] * fitOf(top)));
    const estimates: Record<string, number | null> = {};
    for (const id of kept) {
      const assistant = this.store.assistant(id);
      estimates[id] = assistant ? this.expectedCost(assistant, ask) : null;
    }
    const known = near.map((id) => estimates[id]).filter((value): value is number => typeof value === "number");
    if (known.length === 0) return { order: kept, cost: { prefer, fit: FIT[prefer], top, estimates, reordered: false } };
    const prior = median(known);
    const keyOf = (id: string) => estimates[id] ?? prior;
    const unknown = (id: string) => Number(estimates[id] === null);
    const cheapFirst = [...near].sort((a, b) => keyOf(a) - keyOf(b) || unknown(a) - unknown(b) || fitOf(b) - fitOf(a));
    const order = [...cheapFirst, ...kept.filter((id) => !near.includes(id))];
    return { order, cost: { prefer, fit: FIT[prefer], top, estimates, reordered: order[0] !== top } };
  }

  /**
   * What a call to an assistant is expected to cost: its price on this ask (with its usual answer length),
   * else the middle of what its last calls cost (OpenRouter reports it), else unknown.
   */
  expectedCost(assistant: Assistant, ask: string): number | null {
    const history = this.store.recentSpend(assistant.id);
    if (priceOf(assistant)) {
      const outputTokens = history.length ? median(history.map((call) => call.outputTokens)) : TYPICAL_OUTPUT_TOKENS;
      return costOf(assistant, { inputTokens: estimateTokens(ask) + TYPICAL_MEMORY_TOKENS, outputTokens });
    }
    return history.length ? median(history.map((call) => call.costUsd)) : null;
  }

  /** The key a kept answer is found by: the assistant as set up, what it may read of memory, and the ask. */
  private reuseKey(assistant: Assistant, ask: string): string {
    const { reuseMinutes: _minutes, price: _price, description: _description, ...setup } = assistant;
    const notes = this.store.notes("kept").filter((note) => assistant.memory.includes(note.slice)).map((note) => `${note.id}:${note.note}`);
    const said = ask.normalize("NFKC").replace(/\s+/g, " ").trim();
    return createHash("sha256").update(JSON.stringify({ setup, notes, said })).digest("hex");
  }

  /** Asks the first of `ids` that answers. */
  async ask(ids: readonly string[], ask: string, reuse = true): Promise<Routed> {
    const tried: Attempt[] = [];
    const budget = this.engine.budget;
    const over = budget ? this.engine.spent() >= budget.usd : false;
    for (const id of ids) {
      const assistant = this.store.assistant(id);
      if (!assistant) {
        tried.push({ id, error: `There's no assistant "${id}". Yours: ${this.store.assistants().map((one) => one.id).join(", ") || "none yet"}.` });
        continue;
      }
      const key = assistant.reuseMinutes && reuse ? this.reuseKey(assistant, ask) : null;
      const kept = key ? this.store.keptAnswer(key) : null;
      if (kept) {
        this.store.addReuse(kept.runId, assistant.id, kept.costUsd);
        return { assistant, route: null, text: kept.text, data: kept.data ?? null, runId: kept.runId, skipped: tried, reused: true, cost: { inputTokens: 0, outputTokens: 0, costUsd: 0, estimated: false } };
      }
      if (over && budget && paid(assistant)) {
        tried.push({ id, error: `The budget (${dollars(budget.usd)} a ${budget.period}) is spent, and "${id}" costs money.`, overBudget: true });
        continue;
      }
      const flow = parseFlow({
        name: `Router: ${assistant.name ?? assistant.id}`,
        assistants: [assistant],
        steps: [{ id: "reply", type: "agent", agent: assistant.id, ask: "{{input}}" }],
      });
      const view = await this.engine.start(flow, ask);
      const reply = view.context.steps.reply;
      if (view.state === "done" && reply) {
        const answered = this.store.logOf(view.id).findLast((line) => line.kind === "answered");
        const cost = (answered?.detail as { cost?: Spend } | null)?.cost ?? null;
        if (key && assistant.reuseMinutes) this.store.keepAnswer(key, { assistant: assistant.id, runId: view.id, text: reply.text, data: reply.data ?? null, costUsd: cost?.costUsd ?? null }, assistant.reuseMinutes);
        return { assistant, route: null, text: reply.text, data: reply.data ?? null, runId: view.id, skipped: tried, reused: false, cost };
      }
      tried.push({ id, error: view.error ?? `The run ended ${view.state}.` });
    }
    throw new NoAnswer(tried);
  }
}
