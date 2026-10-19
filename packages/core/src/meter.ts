import { type Budget, budgetName, dollars, periodStart, type Spend } from "./cost.ts";
import type { Store } from "./store.ts";
import { isTokenFactory, tokenFactoryPrice } from "./tokenfactory.ts";

/**
 * Huddle's own model calls: drafting flows, judging "auto", choosing and filling views, checking facts,
 * learning from what you say, tidying memory. The engine counts and caps what hand-offs cost; these are
 * Huddle's, so the meter adds them to the same spend (the Spend page shows them as "huddle: <job>"),
 * stops them once HUDDLE_BUDGET is spent, and holds them to so many a minute. A Huddle other people can
 * reach, like a demo, then can't run up a bill.
 */
export type OwnJob = "describe it" | "auto judge" | "views" | "fact check" | "learning" | "tidy up";

/** An own call the meter turned down: the budget is spent, or too many came at once. */
export class OwnLimit extends Error {
  override readonly name = "OwnLimit";
}

/** Huddle's own calls a minute, by default: a fact check is up to 7 (two model calls, five searches). */
export const OWN_CALLS_PER_MINUTE = 30;

export interface MeterOptions {
  /** The cap on what Huddle spends (HUDDLE_BUDGET): its own calls stop once it's spent. */
  readonly budget?: Budget | null;
  /** The most own calls in any minute (HUDDLE_OWN_CALLS_PER_MINUTE). */
  readonly perMinute?: number;
  readonly now?: () => number;
  readonly fetcher?: typeof fetch;
}

export class Meter {
  readonly perMinute: number;
  private readonly store: Store;
  private readonly budget: Budget | null;
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;
  /** When each call in the last minute went out, oldest first. */
  private readonly recent: number[] = [];

  constructor(store: Store, options: MeterOptions = {}) {
    this.store = store;
    this.budget = options.budget ?? null;
    this.perMinute = options.perMinute ?? OWN_CALLS_PER_MINUTE;
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetcher ?? globalThis.fetch;
  }

  /**
   * A fetch for one job. It refuses with OwnLimit, without calling out, once the budget is spent or the
   * minute's calls are used up; and it adds what each call cost to spend, unless the job adds that to its
   * own run already (fact checks and learning do: record false).
   */
  fetchFor(job: OwnJob, options: { readonly record?: boolean } = {}): typeof fetch {
    const record = options.record ?? true;
    return async (input, init) => {
      this.admit(job);
      const response = await this.fetcher(input, init);
      if (record && response.ok) await this.record(job, input, init, response);
      return response;
    };
  }

  /** Own calls in the last minute. */
  callsLastMinute(): number {
    this.forget();
    return this.recent.length;
  }

  private admit(job: OwnJob): void {
    if (this.budget) {
      const since = periodStart(this.budget.period, new Date(this.now())).toISOString();
      const spent = this.store.spendSince(since).reduce((sum, total) => sum + total.usd, 0);
      if (spent >= this.budget.usd) {
        throw new OwnLimit(`${capital(budgetName(this.budget.period))} budget is spent (${dollars(spent)} of ${dollars(this.budget.usd)}), so Huddle's ${job} waits until ${this.budget.period === "day" ? "tomorrow" : "next month"}.`);
      }
    }
    this.forget();
    if (this.recent.length >= this.perMinute) {
      throw new OwnLimit(`Huddle has made ${this.recent.length} of its own model calls in the last minute, its most, so ${job} waits: try again in a minute.`);
    }
    this.recent.push(this.now());
  }

  private forget(): void {
    const minuteAgo = this.now() - 60_000;
    while (this.recent.length && (this.recent[0] ?? 0) <= minuteAgo) this.recent.shift();
  }

  /** Tokens from the answer's usage; the cost where Huddle knows the model's price (Token Factory's). */
  private async record(job: OwnJob, input: Parameters<typeof fetch>[0], init: RequestInit | undefined, response: Response): Promise<void> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let model: unknown;
    try {
      model = (JSON.parse(typeof init?.body === "string" ? init.body : "null") as { model?: unknown } | null)?.model;
    } catch {
      model = undefined;
    }
    const usage = (await response
      .clone()
      .json()
      .then((body: { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null) => body?.usage)
      .catch(() => undefined)) as { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined;
    const inputTokens = typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : 0;
    const outputTokens = typeof usage?.completion_tokens === "number" ? usage.completion_tokens : 0;
    const price = isTokenFactory(url) && typeof model === "string" ? tokenFactoryPrice(model) : null;
    const spend: Spend = { inputTokens, outputTokens, costUsd: price ? (inputTokens * price.input + outputTokens * price.output) / 1_000_000 : null, estimated: false };
    this.store.addOwnSpend(job, spend);
  }
}

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
