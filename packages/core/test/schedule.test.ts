import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextRun, type ScheduleTrigger, scheduleText } from "../src/schedule.ts";
import { Trigger } from "../src/schema.ts";

const schedule = (fields: Record<string, unknown>) => Trigger.parse({ type: "schedule", ...fields }) as ScheduleTrigger;
const at = (iso: string) => new Date(iso).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

describe("schedules", () => {
  it("run at a time of day on their days, by their time zone's clock", () => {
    const friday = schedule({ at: "18:00", on: ["fri"], timezone: "Asia/Kolkata" });
    // Thursday 15 Oct 2026, 17:30 in Kolkata: next is Friday 18:00 IST, 12:30 UTC.
    assert.equal(iso(nextRun(friday, at("2026-10-15T12:00:00Z"))), "2026-10-16T12:30:00.000Z");
    // Right at it: the next one is a week on.
    assert.equal(iso(nextRun(friday, at("2026-10-16T12:30:00Z"))), "2026-10-23T12:30:00.000Z");
    const weekdays = schedule({ at: "08:00", on: ["mon", "tue", "wed", "thu", "fri"], timezone: "America/New_York" });
    // Friday 16 Oct, 09:00 in New York: next is Monday 19 Oct, 08:00 EDT.
    assert.equal(iso(nextRun(weekdays, at("2026-10-16T13:00:00Z"))), "2026-10-19T12:00:00.000Z");
    // After the clocks go back (1 Nov), 08:00 is EST, an hour later in UTC.
    assert.equal(iso(nextRun(weekdays, at("2026-11-01T12:00:00Z"))), "2026-11-02T13:00:00.000Z");
  });

  it("run a skipped time an hour later, and every-so-often ones from when they're counted", () => {
    // London's clocks go from 01:00 to 02:00 on 29 Mar 2026: 01:30 never happens, so it runs at 02:30 BST.
    const early = schedule({ at: "01:30", on: ["sun"], timezone: "Europe/London" });
    assert.equal(iso(nextRun(early, at("2026-03-28T12:00:00Z"))), "2026-03-29T01:30:00.000Z");
    assert.equal(nextRun(schedule({ every: "2h" }), 1_000), 1_000 + 7_200_000);
  });

  it("say what they are, and turn away schedules that don't make sense", () => {
    assert.equal(scheduleText(schedule({ every: "15m" })), "Every 15m");
    assert.equal(scheduleText(schedule({ at: "18:00", on: ["fri"], timezone: "Asia/Kolkata" })), "Fridays at 18:00 (Asia/Kolkata)");
    assert.equal(scheduleText(schedule({ at: "08:00", on: ["fri", "mon", "wed", "tue", "thu"] })), "Weekdays at 08:00");
    assert.equal(scheduleText(schedule({ at: "10:00", on: ["sun", "sat"] })), "Weekends at 10:00");
    assert.equal(scheduleText(schedule({ at: "07:15" })), "Every day at 07:15");
    for (const bad of [{}, { every: "1d", at: "08:00" }, { every: "1d", on: ["mon"] }, { at: "25:00" }, { at: "08:00", timezone: "Mars/Olympus" }, { at: "08:00", on: [] }]) {
      assert.equal(Trigger.safeParse({ type: "schedule", ...bad }).success, false, JSON.stringify(bad));
    }
  });
});
