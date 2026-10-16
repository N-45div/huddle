import type { RunState, Trigger } from "./types.ts";

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const timeOnly = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "just now", "5 minutes ago", "yesterday", then a date. */
export function ago(iso: string | null | undefined): string {
  const date = parse(iso);
  if (!date) return "";
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "just now";
  if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), "hour");
  if (abs < 7 * 86_400) return relative.format(Math.round(seconds / 86_400), "day");
  return dateTime.format(date);
}

export function fullTime(iso: string | null | undefined): string {
  const date = parse(iso);
  return date ? dateTime.format(date) : "";
}

export function clockTime(iso: string | null | undefined): string {
  const date = parse(iso);
  return date ? timeOnly.format(date) : "";
}

const DAY_NAMES = { mon: "Mondays", tue: "Tuesdays", wed: "Wednesdays", thu: "Thursdays", fri: "Fridays", sat: "Saturdays", sun: "Sundays" } as const;

/** A schedule in words, as the server says it: "Every 2h", "Fridays at 18:00 (Asia/Kolkata)", "Weekdays at 08:00". */
function scheduleSummary(trigger: Extract<Trigger, { type: "schedule" }>): string {
  if (trigger.every || !trigger.at) return `Every ${trigger.every ?? "?"}`;
  const order = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
  const days = new Set(trigger.on ?? order);
  const weekdays = days.size === 5 && ["mon", "tue", "wed", "thu", "fri"].every((day) => days.has(day as (typeof order)[number]));
  const when = days.size === 7 ? "Every day" : weekdays ? "Weekdays" : days.size === 2 && days.has("sat") && days.has("sun") ? "Weekends" : order.filter((day) => days.has(day)).map((day) => DAY_NAMES[day]).join(", ");
  return `${when} at ${trigger.at}${trigger.timezone ? ` (${trigger.timezone})` : ""}`;
}

export function triggerSummary(trigger: Trigger | undefined): string {
  if (!trigger || trigger.type === "manual") return "Manual";
  if (trigger.type === "schedule") return scheduleSummary(trigger);
  if (trigger.type === "email") return `Email to ${trigger.address}`;
  return "Webhook";
}

export const STATE_LABEL: Record<RunState, string> = {
  running: "Running",
  waiting: "Waiting for you",
  done: "Done",
  declined: "Declined",
  failed: "Failed",
};

/** Dollars, readably: $0.0042, $1.25. */
export function dollars(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toPrecision(2)}`;
  return `$${usd.toFixed(2)}`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A readable JSON block for structured answers. */
export function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}
