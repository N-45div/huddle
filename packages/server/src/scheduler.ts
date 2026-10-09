import { type Change, type Engine, everyMs, type Store } from "@huddle/core";

/**
 * Runs scheduled flows. Each flow with a schedule trigger gets a timer, counted from when the server
 * starts or the flow is saved (missed runs while Huddle was off aren't made up). A flow whose last run
 * is still going, or waiting on an approval, is skipped until that run settles.
 */

/** setTimeout can't wait longer than this (about 24.8 days); longer waits are chained. */
const LONGEST = 2_147_483_647;

interface Slot {
  readonly every: string;
  readonly dueAt: number;
  timer: NodeJS.Timeout;
}

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

  /** The scheduled flows and when each runs next. */
  scheduled(): { flowId: string; every: string; dueAt: string }[] {
    return [...this.slots].map(([flowId, slot]) => ({ flowId, every: slot.every, dueAt: new Date(slot.dueAt).toISOString() }));
  }

  /** Matches the timers to the saved flows: new schedules start, changed ones restart, removed ones stop. */
  refresh(): void {
    const wanted = new Map<string, string>();
    for (const saved of this.store.flows()) if (saved.flow.trigger.type === "schedule") wanted.set(saved.id, saved.flow.trigger.every);
    for (const [flowId, slot] of this.slots) {
      if (wanted.get(flowId) !== slot.every) {
        clearTimeout(slot.timer);
        this.slots.delete(flowId);
      }
    }
    for (const [flowId, every] of wanted) if (!this.slots.has(flowId)) this.plan(flowId, every, Date.now() + everyMs(every));
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

  private plan(flowId: string, every: string, dueAt: number): void {
    const timer = setTimeout(() => {
      if (Date.now() < dueAt) return this.plan(flowId, every, dueAt);
      this.plan(flowId, every, dueAt + everyMs(every));
      this.fire(flowId);
    }, Math.min(LONGEST, Math.max(0, dueAt - Date.now())));
    timer.unref();
    this.slots.set(flowId, { every, dueAt, timer });
  }
}
