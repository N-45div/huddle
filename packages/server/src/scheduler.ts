import { type Change, type Engine, nextRun, type ScheduleTrigger, scheduleText, type Store } from "@huddle/core";

/**
 * Runs scheduled flows. Each flow with a schedule trigger gets a timer: one that runs every so often counts
 * from when the server starts or the flow is saved; one at a time of day waits for that time on its days,
 * by its time zone's clock. Missed runs while Huddle was off aren't made up. A flow whose last run is still
 * going, or waiting on an approval, is skipped until that run settles.
 */

/** setTimeout can't wait longer than this (about 24.8 days); longer waits are chained. */
const LONGEST = 2_147_483_647;

interface Slot {
  /** The schedule as it was when its timer started, to notice when it's changed. */
  readonly key: string;
  readonly text: string;
  readonly dueAt: number;
  timer: NodeJS.Timeout;
}

/** What makes two schedules the same: everything but the run's input. */
const keyOf = (trigger: ScheduleTrigger): string => JSON.stringify([trigger.every ?? null, trigger.at ?? null, trigger.on ?? null, trigger.timezone ?? null]);

export class Scheduler {
  private readonly store: Store;
  private readonly engine: Engine;
  private readonly slots = new Map<string, Slot>();
  private readonly onChange = (change: Change) => {
    if (change.kind === "flow") this.refresh();
  };

  constructor(store: Store, engine: Engine) {
    this.store = store;
    this.engine = engine;
  }

  start(): void {
    this.refresh();
    this.store.events.on("change", this.onChange);
  }

  stop(): void {
    this.store.events.off("change", this.onChange);
    for (const slot of this.slots.values()) clearTimeout(slot.timer);
    this.slots.clear();
  }

  /** The scheduled flows, their schedules in words, and when each runs next. */
  scheduled(): { flowId: string; schedule: string; dueAt: string }[] {
    return [...this.slots].map(([flowId, slot]) => ({ flowId, schedule: slot.text, dueAt: new Date(slot.dueAt).toISOString() }));
  }

  /** Matches the timers to the saved flows: new schedules start, changed ones restart, removed ones stop. */
  refresh(): void {
    const wanted = new Map<string, ScheduleTrigger>();
    for (const saved of this.store.flows()) if (saved.flow.trigger.type === "schedule") wanted.set(saved.id, saved.flow.trigger);
    for (const [flowId, slot] of this.slots) {
      const trigger = wanted.get(flowId);
      if (!trigger || keyOf(trigger) !== slot.key) {
        clearTimeout(slot.timer);
        this.slots.delete(flowId);
      }
    }
    for (const [flowId, trigger] of wanted) if (!this.slots.has(flowId)) this.plan(flowId, trigger, nextRun(trigger, Date.now()));
  }

  /** Runs a scheduled flow now, unless its last run hasn't settled. Returns the new run's id, or null if skipped. */
  fire(flowId: string): string | null {
    const saved = this.store.flow(flowId);
    if (!saved || saved.flow.trigger.type !== "schedule") return null;
    const last = this.store.runs(1, flowId)[0];
    if (last && (last.state === "running" || last.state === "waiting")) {
      console.log(`[huddle] skipped "${saved.flow.name}": its last run (${last.id}) is still ${last.state}.`);
      return null;
    }
    return this.engine.launch(saved.flow, saved.flow.trigger.input, saved.id);
  }

  private plan(flowId: string, trigger: ScheduleTrigger, dueAt: number): void {
    const timer = setTimeout(() => {
      if (Date.now() < dueAt) return this.plan(flowId, trigger, dueAt);
      this.plan(flowId, trigger, nextRun(trigger, dueAt));
      this.fire(flowId);
    }, Math.min(LONGEST, Math.max(0, dueAt - Date.now())));
    timer.unref();
    this.slots.set(flowId, { key: keyOf(trigger), text: scheduleText(trigger), dueAt, timer });
  }
}
