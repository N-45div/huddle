import { evaluate } from "./condition.ts";
import { type Connector, memoryText, type Reply } from "./connector.ts";
import { type Budget, budgetName, dollars, periodStart, priceOf, spendOf } from "./cost.ts";
import type { FactCheck, FactChecker } from "./factcheck.ts";
import type { Guard } from "./guard.ts";
import { Memory } from "./memory/memory.ts";
import type { Flow, Step } from "./schema.ts";
import type { Approval, Run, Store } from "./store.ts";
import { type RunContext, render } from "./template.ts";

/**
 * Runs flows. A run goes step by step, saving after each one; at an approval it saves and stops, and
 * `decide` picks it up again later, from a fresh process if need be, since everything is in the store.
 */

/** A loop in a flow can't spin forever: a run stops after this many steps. */
export const MAX_STEPS = 100;

export interface RunView {
  readonly id: string;
  readonly flowId: string | null;
  readonly state: Run["state"];
  readonly at: string | null;
  readonly error: string | null;
  /** What the run is waiting on, when it is; heldBy when only a guard's own approver can say yes. */
  readonly waiting: Pick<Approval, "id" | "message" | "heldBy"> | null;
  readonly context: RunContext;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Who started a run from outside, and how: the first line of its log. */
export interface StartedBy {
  readonly name: string;
  readonly tier: string;
  /** "a2a", "email", ... */
  readonly via: string;
}

export interface EngineOptions {
  /** Picks the notes each agent step sends (default: found by their words, within Sochen's budget). */
  readonly memory?: Memory;
  /** Looks at each hand-off before it's made (ArmorIQ); none by default. */
  readonly guard?: Guard;
  /** A cap on what hand-offs to paid assistants may spend; none by default. */
  readonly budget?: Budget | null;
  /** Checks the facts in an approval's message on the web, for steps that ask (`check: true`); none by default. */
  readonly checker?: FactChecker;
}

/** A hand-off to a paid assistant when the budget is spent. */
export class OverBudget extends Error {}

/** A yes for a hand-off that only its guard's approver can release. */
export class HeldElsewhere extends Error {
  readonly url: string;
  constructor(by: string, url: string) {
    super(`${by} holds this one: approve it in ${by} (${url}), and the run carries on by itself. You can still say no here.`);
    this.url = url;
  }
}

export class Engine {
  readonly store: Store;
  readonly connectors: Readonly<Record<string, Connector>>;
  readonly memory: Memory;
  readonly guard: Guard | null;
  readonly budget: Budget | null;
  readonly checker: FactChecker | null;

  constructor(store: Store, connectors: Readonly<Record<string, Connector>>, options: EngineOptions = {}) {
    this.store = store;
    this.connectors = connectors;
    this.memory = options.memory ?? new Memory(store);
    this.guard = options.guard ?? null;
    this.budget = options.budget ?? null;
    this.checker = options.checker ?? null;
  }

  /** What hand-offs with a known cost have spent in the budget's period (this month without one). */
  spent(): number {
    const since = periodStart(this.budget?.period ?? "month").toISOString();
    return this.store.spendSince(since).reduce((sum, total) => sum + total.usd, 0);
  }

  async start(flow: Flow, input: string, flowId: string | null = null, startedBy?: StartedBy): Promise<RunView> {
    const run = this.store.createRun(flow, input, flowId);
    if (startedBy) this.store.log(run.id, "trigger", "started", startedBy);
    return this.advance(run, flow.steps[0]?.id ?? "end");
  }

  /** Starts a run and returns its id at once; the run carries on in the background (for the server). */
  launch(flow: Flow, input: string, flowId: string | null = null, startedBy?: StartedBy): string {
    const run = this.store.createRun(flow, input, flowId);
    if (startedBy) this.store.log(run.id, "trigger", "started", startedBy);
    void this.advance(run, flow.steps[0]?.id ?? "end").catch((error: unknown) => console.error(`[huddle] run ${run.id} stopped:`, error));
    return run.id;
  }

  /** Answers an approval and returns at once; the run carries on in the background. Throws straight away if it can't be answered. */
  answer(approvalId: string, yes: boolean): string {
    const approval = this.store.approval(approvalId);
    if (!approval) throw new Error(`There's no approval ${approvalId}.`);
    if (approval.status !== "waiting") throw new Error(`Approval ${approvalId} was already answered (${approval.status}).`);
    if (yes && approval.heldBy) throw new HeldElsewhere(approval.heldBy.by, approval.heldBy.url);
    void this.decide(approvalId, yes).catch((error: unknown) => console.error(`[huddle] approval ${approvalId}:`, error));
    return approval.runId;
  }

  /**
   * Answers an approval and carries its run on: yes goes to `next`, no to `onNo` or ends the run as declined.
   * A hand-off held by a guard's own approver takes a yes only from there (`released`); a no works anywhere.
   */
  async decide(approvalId: string, yes: boolean, options: { readonly released?: boolean } = {}): Promise<RunView> {
    const approval = this.store.approval(approvalId);
    if (!approval) throw new Error(`There's no approval ${approvalId}.`);
    if (yes && approval.heldBy && !options.released) throw new HeldElsewhere(approval.heldBy.by, approval.heldBy.url);
    const run = this.store.run(approval.runId);
    if (!run) throw new Error(`The run for approval ${approvalId} is gone.`);
    if (!this.store.decide(approvalId, yes)) throw new Error(`Approval ${approvalId} was already answered (${approval.status}).`);
    const step = run.flow.steps.find((candidate) => candidate.id === approval.stepId);
    // A hand-off the guard held: yes makes it, without asking the guard again; no ends the run.
    if (step?.type === "agent") {
      this.store.log(run.id, step.id, yes ? "approved" : "declined", { message: approval.message });
      if (yes) return this.advance(run, step.id, step.id);
      return this.end(run.id, "declined", null, run.context, null);
    }
    if (!step || step.type !== "approval") throw new Error(`Approval ${approvalId} points at a step that isn't an approval.`);
    this.store.log(run.id, step.id, yes ? "approved" : "declined", { message: approval.message });
    const context: RunContext = { ...run.context, steps: { ...run.context.steps, [step.id]: { text: yes ? "yes" : "no", data: yes } } };
    if (yes) return this.advance({ ...run, context }, step.next ?? following(run.flow, step));
    if (step.onNo) return this.advance({ ...run, context }, step.onNo);
    return this.end(run.id, "declined", null, context, null);
  }

  view(runId: string): RunView {
    const run = this.store.run(runId);
    if (!run) throw new Error(`There's no run ${runId}.`);
    const waiting = run.state === "waiting" ? this.store.waitingApproval(run.id) : null;
    return {
      id: run.id,
      flowId: run.flowId,
      state: run.state,
      at: run.at,
      error: run.error,
      waiting: waiting ? { id: waiting.id, message: waiting.message, heldBy: waiting.heldBy } : null,
      context: run.context,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  }

  /** `cleared` is a held hand-off you've said yes to: it's made without asking the guard again. */
  private async advance(run: Run, from: string, cleared: string | null = null): Promise<RunView> {
    let context = run.context;
    let target = from;
    // Carrying on after an approval: say so now, not after the next step (an assistant can take minutes).
    if (run.state !== "running" && target !== "end") this.store.saveRun({ id: run.id, state: "running", at: target, context, error: null });
    const done = Object.keys(context.steps).length;
    for (let count = done; ; count += 1) {
      if (target === "end") return this.end(run.id, "done", null, context, null);
      const step = run.flow.steps.find((candidate) => candidate.id === target);
      if (!step) return this.fail(run.id, target, context, `There's no step "${target}".`);
      if (count >= MAX_STEPS) return this.fail(run.id, step.id, context, `Stopped after ${MAX_STEPS} steps; the flow probably loops.`);
      try {
        const outcome = await this.runStep(run, step, context, cleared === step.id);
        if (outcome.wait) {
          this.store.saveRun({ id: run.id, state: "waiting", at: step.id, context, error: null });
          return this.view(run.id);
        }
        context = outcome.context;
        target = outcome.next;
        this.store.saveRun({ id: run.id, state: "running", at: target === "end" ? null : target, context, error: null });
      } catch (error) {
        return this.fail(run.id, step.id, context, error instanceof Error ? error.message : String(error));
      }
    }
  }

  private async runStep(run: Run, step: Step, context: RunContext, cleared = false): Promise<{ wait: true } | { wait: false; context: RunContext; next: string }> {
    const keep = (text: string, data?: unknown): RunContext => ({ ...context, steps: { ...context.steps, [step.id]: data === undefined ? { text } : { text, data } } });
    switch (step.type) {
      case "agent": {
        const assistant = run.flow.assistants.find((candidate) => candidate.id === step.agent);
        if (!assistant) throw new Error(`Step "${step.id}" asks "${step.agent}", which isn't one of the flow's assistants.`);
        const connector = this.connectors[assistant.connector];
        if (!connector) throw new Error(`There's no "${assistant.connector}" connector set up for "${assistant.id}".`);
        const handOff = { run, step, assistant };
        if (this.guard && !cleared) {
          const verdict = await this.guard.check(handOff);
          this.store.log(run.id, step.id, "guarded", { by: this.guard.name, assistant: assistant.id, ...verdict });
          if (verdict.action === "block") throw new Error(`${this.guard.name} stopped the hand-off to "${assistant.id}": ${verdict.reason}.`);
          if (verdict.action === "hold") {
            // Filed with the guard's own approver (ArmorIQ): approved there, and Huddle carries on by itself.
            const heldBy = verdict.heldBy && this.guard.awaitRelease ? verdict.heldBy : null;
            const message = heldBy
              ? `${this.guard.name} held the hand-off to "${assistant.id}" (${verdict.reason}). Approve it in ${heldBy.by}; the run carries on by itself once you do.`
              : `${this.guard.name} held the hand-off to "${assistant.id}" (${verdict.reason}). Let it go ahead?`;
            const approval = this.store.addApproval(run.id, step.id, message, heldBy);
            this.store.log(run.id, step.id, "waiting", { approval: approval.id, message, ...(heldBy ? { heldBy } : {}) });
            if (heldBy) this.watch(approval);
            return { wait: true };
          }
        }
        // Over budget, paid assistants wait; free ones and those without a price carry on.
        const price = priceOf(assistant);
        if (this.budget && price && (price.input > 0 || price.output > 0 || price.call > 0)) {
          const spent = this.spent();
          if (spent >= this.budget.usd) throw new OverBudget(`${capital(budgetName(this.budget.period))} budget is spent (${dollars(spent)} of ${dollars(this.budget.usd)}), so "${assistant.id}", which costs money, wasn't asked. Raise HUDDLE_BUDGET, or wait for the next ${this.budget.period}.`);
        }
        const ask = render(step.ask, context);
        // Kept notes from this assistant's slices only: all that fit the budget, the ones about this ask first.
        const memory = await this.memory.recall(ask, assistant.memory);
        this.store.log(run.id, step.id, "asked", { assistant: assistant.id, ask, memory: memory.map((note) => note.id) });
        const started = performance.now();
        let reply: Reply;
        try {
          reply = await connector.send({ assistant, ask, memory, runId: run.id });
        } catch (error) {
          void this.guard?.report(handOff, { ok: false, chars: 0, error: error instanceof Error ? error.message : String(error), ms: Math.round(performance.now() - started) });
          throw error;
        }
        const { usage, ...answer } = reply;
        const cost = spendOf(assistant, usage, memory.length ? `${memoryText(memory)}\n${ask}` : ask, answer.text);
        const counted = usage ? { model: assistant.model ?? assistant.connector, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: usage.cachedTokens ?? 0 } : undefined;
        void this.guard?.report(handOff, { ok: true, chars: reply.text.length, ms: Math.round(performance.now() - started), ...(counted ? { usage: counted } : {}) });
        this.store.addSpend(run, step.id, assistant.id, cost);
        this.store.log(run.id, step.id, "answered", { ...answer, cost });
        return { wait: false, context: keep(answer.text, answer.data), next: step.next ?? following(run.flow, step) };
      }
      case "condition": {
        const result = evaluate(step.if, context);
        this.store.log(run.id, step.id, "checked", { if: render(step.if, context), result });
        return { wait: false, context: keep(String(result), result), next: result ? step.then : step.else };
      }
      case "approval": {
        const message = render(step.message, context);
        const checks = step.check ? await this.checkFacts(run, step.id, message) : null;
        const approval = this.store.addApproval(run.id, step.id, message, null, checks);
        this.store.log(run.id, step.id, "waiting", { approval: approval.id, message });
        return { wait: true };
      }
      case "memory": {
        const note = render(step.note, context);
        const suggested = this.store.suggest(step.slice, note, `run ${run.id}, step ${step.id}`);
        this.store.log(run.id, step.id, "suggested", { note: suggested.id, slice: step.slice, text: suggested.note });
        return { wait: false, context: keep(note), next: step.next ?? following(run.flow, step) };
      }
    }
  }

  /** Waits on every held approval still waiting (after a restart, say): they carry on when their approver decides. */
  resumeHolds(): number {
    const held = this.store.waitingApprovals().filter((approval) => approval.heldBy);
    for (const approval of held) this.watch(approval);
    return held.length;
  }

  private readonly watching = new Set<string>();

  /** Waits for a held approval's own approver; a no given here first wins. */
  private watch(approval: Approval): void {
    if (!approval.heldBy || !this.guard?.awaitRelease || this.watching.has(approval.id)) return;
    this.watching.add(approval.id);
    const heldBy = approval.heldBy;
    void this.guard
      .awaitRelease(heldBy)
      .then(async (outcome) => {
        if (this.store.approval(approval.id)?.status !== "waiting") return;
        this.store.log(approval.runId, approval.stepId, outcome === "approved" ? "released" : "refused", { by: heldBy.by, outcome });
        await this.decide(approval.id, outcome === "approved", { released: true });
      })
      .catch((error: unknown) => console.error(`[huddle] waiting on ${heldBy.by} for approval ${approval.id}:`, error))
      .finally(() => this.watching.delete(approval.id));
  }

  /**
   * What the web says about the facts in an approval's message, before the person is asked. A check that
   * can't run never stops the approval: the person is still asked, and the log says why it wasn't checked.
   */
  private async checkFacts(run: Run, stepId: string, message: string): Promise<FactCheck | null> {
    if (!this.checker) {
      this.store.log(run.id, stepId, "unchecked", { reason: "Checking facts needs TAVILY_API_KEY and a model (NEBIUS_API_KEY, or HUDDLE_LLM_URL and HUDDLE_LLM_MODEL)." });
      return null;
    }
    try {
      const checks = await this.checker(message);
      const count = (verdict: string) => checks.facts.filter((fact) => fact.verdict === verdict).length;
      this.store.log(run.id, stepId, "fact-checked", { facts: checks.facts.length, supported: count("supported"), contradicted: count("contradicted"), unclear: count("unclear"), by: checks.checkedBy, costUsd: checks.costUsd, claims: checks.facts.map((fact) => fact.claim), sentTo: checks.sentTo });
      if (checks.costUsd > 0) this.store.addSpend(run, stepId, "fact-check", { inputTokens: 0, outputTokens: 0, costUsd: checks.costUsd, estimated: false });
      return checks;
    } catch (error) {
      this.store.log(run.id, stepId, "unchecked", { reason: `Couldn't check the facts: ${error instanceof Error ? error.message : String(error)}` });
      return null;
    }
  }

  private fail(runId: string, stepId: string, context: RunContext, error: string): RunView {
    this.store.log(runId, stepId, "failed", { error });
    return this.end(runId, "failed", stepId, context, error);
  }

  /** A run is over: saved, and the guard told. */
  private end(runId: string, state: "done" | "failed" | "declined", at: string | null, context: RunContext, error: string | null): RunView {
    this.store.saveRun({ id: runId, state, at, context, error });
    void this.guard?.finish(runId, state);
    return this.view(runId);
  }
}

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** The step after this one in the file, or "end". */
function following(flow: Flow, step: Step): string {
  const index = flow.steps.findIndex((candidate) => candidate.id === step.id);
  return flow.steps[index + 1]?.id ?? "end";
}
