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

export function triggerSummary(trigger: Trigger | undefined): string {
  if (!trigger || trigger.type === "manual") return "Manual";
  if (trigger.type === "schedule") return `Every ${trigger.every}`;
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
