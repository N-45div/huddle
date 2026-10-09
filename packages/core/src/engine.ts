import { evaluate } from "./condition.ts";
import type { Connector } from "./connector.ts";
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
  /** What the run is waiting on, when it is. */
  readonly waiting: Pick<Approval, "id" | "message"> | null;
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
}

export class Engine {
  readonly store: Store;
  readonly connectors: Readonly<Record<string, Connector>>;
  readonly memory: Memory;

  constructor(store: Store, connectors: Readonly<Record<string, Connector>>, options: EngineOptions = {}) {
    this.store = store;
    this.connectors = connectors;
    this.memory = options.memory ?? new Memory(store);
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
    void this.decide(approvalId, yes).catch((error: unknown) => console.error(`[huddle] approval ${approvalId}:`, error));
    return approval.runId;
  }

  /** Answers an approval and carries its run on: yes goes to `next`, no to `onNo` or ends the run as declined. */
  async decide(approvalId: string, yes: boolean): Promise<RunView> {
    const approval = this.store.approval(approvalId);
    if (!approval) throw new Error(`There's no approval ${approvalId}.`);
    const run = this.store.run(approval.runId);
    if (!run) throw new Error(`The run for approval ${approvalId} is gone.`);
    if (!this.store.decide(approvalId, yes)) throw new Error(`Approval ${approvalId} was already answered (${approval.status}).`);
    const step = run.flow.steps.find((candidate) => candidate.id === approval.stepId);
    if (!step || step.type !== "approval") throw new Error(`Approval ${approvalId} points at a step that isn't an approval.`);
    this.store.log(run.id, step.id, yes ? "approved" : "declined", { message: approval.message });
    const context: RunContext = { ...run.context, steps: { ...run.context.steps, [step.id]: { text: yes ? "yes" : "no", data: yes } } };
    if (yes) return this.advance({ ...run, context }, step.next ?? following(run.flow, step));
    if (step.onNo) return this.advance({ ...run, context }, step.onNo);
    this.store.saveRun({ id: run.id, state: "declined", at: null, context, error: null });
    return this.view(run.id);
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
      waiting: waiting ? { id: waiting.id, message: waiting.message } : null,
      context: run.context,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  }

  private async advance(run: Run, from: string): Promise<RunView> {
    let context = run.context;
    let target = from;
    // Carrying on after an approval: say so now, not after the next step (an assistant can take minutes).
    if (run.state !== "running" && target !== "end") this.store.saveRun({ id: run.id, state: "running", at: target, context, error: null });
    const done = Object.keys(context.steps).length;
    for (let count = done; ; count += 1) {
      if (target === "end") {
        this.store.saveRun({ id: run.id, state: "done", at: null, context, error: null });
        return this.view(run.id);
      }
      const step = run.flow.steps.find((candidate) => candidate.id === target);
      if (!step) return this.fail(run.id, target, context, `There's no step "${target}".`);
      if (count >= MAX_STEPS) return this.fail(run.id, step.id, context, `Stopped after ${MAX_STEPS} steps; the flow probably loops.`);
      try {
        const outcome = await this.runStep(run, step, context);
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

  private async runStep(run: Run, step: Step, context: RunContext): Promise<{ wait: true } | { wait: false; context: RunContext; next: string }> {
    const keep = (text: string, data?: unknown): RunContext => ({ ...context, steps: { ...context.steps, [step.id]: data === undefined ? { text } : { text, data } } });
    switch (step.type) {
      case "agent": {
        const assistant = run.flow.assistants.find((candidate) => candidate.id === step.agent);
        if (!assistant) throw new Error(`Step "${step.id}" asks "${step.agent}", which isn't one of the flow's assistants.`);
        const connector = this.connectors[assistant.connector];
        if (!connector) throw new Error(`There's no "${assistant.connector}" connector set up for "${assistant.id}".`);
        const ask = render(step.ask, context);
        // Kept notes from this assistant's slices only: all that fit the budget, the ones about this ask first.
        const memory = await this.memory.recall(ask, assistant.memory);
        this.store.log(run.id, step.id, "asked", { assistant: assistant.id, ask, memory: memory.map((note) => note.id) });
        const answer = await connector.send({ assistant, ask, memory, runId: run.id });
        this.store.log(run.id, step.id, "answered", answer);
        return { wait: false, context: keep(answer.text, answer.data), next: step.next ?? following(run.flow, step) };
      }
      case "condition": {
        const result = evaluate(step.if, context);
        this.store.log(run.id, step.id, "checked", { if: render(step.if, context), result });
        return { wait: false, context: keep(String(result), result), next: result ? step.then : step.else };
      }
      case "approval": {
        const message = render(step.message, context);
        const approval = this.store.addApproval(run.id, step.id, message);
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

  private fail(runId: string, stepId: string, context: RunContext, error: string): RunView {
    this.store.log(runId, stepId, "failed", { error });
    this.store.saveRun({ id: runId, state: "failed", at: stepId, context, error });
    return this.view(runId);
  }
}

/** The step after this one in the file, or "end". */
function following(flow: Flow, step: Step): string {
  const index = flow.steps.findIndex((candidate) => candidate.id === step.id);
  return flow.steps[index + 1]?.id ?? "end";
}
