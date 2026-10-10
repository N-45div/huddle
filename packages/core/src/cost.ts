import type { Assistant } from "./schema.ts";

/**
 * What hand-offs cost. Connectors that can say report tokens (and OpenRouter the cost itself); for the
 * rest Huddle estimates from the text's length and says so. Money is US dollars throughout.
 */

/** Tokens one hand-off took, as the assistant reported them. */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Input tokens the provider served from its prompt cache, at its cheaper rate. */
  readonly cachedTokens?: number;
  /** What the provider says it cost (OpenRouter's usage.cost), which beats working it out. */
  readonly costUsd?: number;
}

/** A hand-off's usage with its cost worked out: null when nobody said what the assistant charges. */
export interface Spend extends Omit<Usage, "costUsd"> {
  readonly costUsd: number | null;
  /** The tokens are guessed from the text's length (about four characters a token). */
  readonly estimated: boolean;
}

export type Price = NonNullable<Assistant["price"]>;

const FREE: Price = { input: 0, output: 0, call: 0 };
export const CHARS_PER_TOKEN = 4;

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

const local = (url: string | undefined): boolean => {
  if (!url) return true;
  try {
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};

/** What an assistant charges: its price if you gave one; stand-ins and Ollama on this machine are free; otherwise unknown. */
export function priceOf(assistant: Assistant): Price | null {
  if (assistant.price) return assistant.price;
  if (assistant.connector === "mock") return FREE;
  if (assistant.connector === "ollama" && local(assistant.url)) return FREE;
  return null;
}

/** Usage priced: the provider's own figure when it gave one, else tokens times the assistant's price. */
export function costOf(assistant: Assistant, usage: Usage): number | null {
  if (usage.costUsd !== undefined) return usage.costUsd;
  const price = priceOf(assistant);
  if (!price) return null;
  const cached = Math.min(usage.cachedTokens ?? 0, usage.inputTokens);
  const input = (usage.inputTokens - cached) * price.input + cached * (price.cached ?? price.input);
  return (input + usage.outputTokens * price.output) / 1_000_000 + price.call;
}

/** The usage a connector reported, or a guess from the text in and out, priced. */
export function spendOf(assistant: Assistant, reported: Usage | undefined, sent: string, answer: string): Spend {
  const usage = reported ?? { inputTokens: estimateTokens(sent), outputTokens: estimateTokens(answer) };
  return { ...usage, costUsd: costOf(assistant, usage), estimated: !reported };
}

/** "20/month", "5/day" or "20" (a month): a cap on what paid hand-offs may spend. */
export interface Budget {
  readonly usd: number;
  readonly period: "day" | "month";
}

export function parseBudget(value: string | undefined): Budget | null {
  if (!value?.trim()) return null;
  const match = /^\$?\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(day|month))?$/i.exec(value.trim());
  if (!match) throw new Error(`HUDDLE_BUDGET should look like "20/month" or "5/day" (US dollars), not "${value}".`);
  return { usd: Number(match[1]), period: (match[2]?.toLowerCase() as Budget["period"] | undefined) ?? "month" };
}

/** When the budget's period began (UTC): midnight today, or the first of the month. */
export function periodStart(period: Budget["period"], now = new Date()): Date {
  return period === "day" ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** "today's" or "this month's", for saying which budget. */
export const budgetName = (period: Budget["period"]): string => (period === "day" ? "today's" : "this month's");

/** Dollars, readably: $0.0042, $1.25. */
export function dollars(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toPrecision(2)}`;
  return `$${usd.toFixed(2)}`;
}
