import { everyMs, type Trigger } from "./schema.ts";

/**
 * When a scheduled flow runs next. A schedule runs every so often ("every": "2h"), or at a time of day on
 * some days ("at": "18:00", "on": ["fri"]) by a time zone's clock ("timezone": "Asia/Kolkata"; the server's
 * own when left out). Daylight saving is the zone's: a time the clock passes twice runs once, and a time it
 * skips runs an hour later.
 */

export type ScheduleTrigger = Extract<Trigger, { type: "schedule" }>;

/** Days in JavaScript's order (getUTCDay), by the names a schedule uses. */
export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const formats = new Map<string, Intl.DateTimeFormat>();

/** What a time zone's clock reads at an instant. */
function clockIn(timeZone: string | undefined, instant: number): WallClock {
  const key = timeZone ?? "";
  let format = formats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    formats.set(key, format);
  }
  const parts = Object.fromEntries(format.formatToParts(instant).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute) };
}

/** The instant a time zone's clock reads this date and time. */
function instantAt(timeZone: string | undefined, year: number, month: number, day: number, hour: number, minute: number): number {
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wanted;
  let previous = guess;
  // Each pass moves the guess by how far the zone's clock is from the time wanted; two settle any offset.
  for (let pass = 0; pass < 3; pass++) {
    const seen = clockIn(timeZone, guess);
    const off = wanted - Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
    if (off === 0) return guess;
    previous = guess;
    guess += off;
  }
  // Never settled: the clock skips this time (daylight saving starting), so run once it's past, an hour later.
  return Math.max(previous, guess);
}

/** The next time the schedule runs after `after` (milliseconds since the epoch). */
export function nextRun(trigger: ScheduleTrigger, after: number): number {
  if (trigger.every) return after + everyMs(trigger.every);
  const [hour, minute] = (trigger.at ?? "00:00").split(":").map(Number) as [number, number];
  const today = clockIn(trigger.timezone, after);
  for (let ahead = 0; ahead <= 8; ahead++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + ahead));
    if (trigger.on && !trigger.on.includes(WEEKDAYS[date.getUTCDay()]!)) continue;
    const at = instantAt(trigger.timezone, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute);
    if (at > after) return at;
  }
  throw new Error("A schedule with a time of day always has a next run within a week.");
}

const NAMES: Readonly<Record<Weekday, string>> = { mon: "Mondays", tue: "Tuesdays", wed: "Wednesdays", thu: "Thursdays", fri: "Fridays", sat: "Saturdays", sun: "Sundays" };

/** A schedule in words: "Every 2h", "Fridays at 18:00 (Asia/Kolkata)", "Weekdays at 08:00". */
export function scheduleText(trigger: ScheduleTrigger): string {
  if (trigger.every) return `Every ${trigger.every}`;
  const days = new Set(trigger.on ?? WEEKDAYS);
  const weekdays = ["mon", "tue", "wed", "thu", "fri"] as const;
  const when =
    days.size === 7
      ? "Every day"
      : days.size === 5 && weekdays.every((day) => days.has(day))
        ? "Weekdays"
        : days.size === 2 && days.has("sat") && days.has("sun")
          ? "Weekends"
          : WEEKDAYS.filter((day) => days.has(day)).map((day) => NAMES[day]).join(", ");
  return `${when} at ${trigger.at}${trigger.timezone ? ` (${trigger.timezone})` : ""}`;
}
