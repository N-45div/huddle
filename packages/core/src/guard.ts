import type { Assistant, Step } from "./schema.ts";
import type { HeldBy, Run, RunState } from "./store.ts";

/**
 * A guard looks at each hand-off before the engine makes it, and can let it through, stop it, or hold it
 * for your yes. ArmorIQ is the one Huddle ships (guards/armoriq.ts); tests bring their own.
 */

export type AgentStep = Extract<Step, { type: "agent" }>;

/** One step handing work to one assistant. */
export interface HandOff {
  readonly run: Run;
  readonly step: AgentStep;
  readonly assistant: Assistant;
}

export interface Verdict {
  readonly action: "allow" | "block" | "hold";
  /** Why, in plain words. */
  readonly reason: string;
  /** The guard's own words for it, e.g. ArmorIQ's "tool_not_in_allowlist". */
  readonly code?: string;
  /** The rule that decided it, when the guard says. */
  readonly policy?: string;
  /** A hold filed with the guard's own approver: only a yes there releases it. */
  readonly heldBy?: HeldBy;
}

/** What came of a hand-off the guard let through. */
export interface Outcome {
  readonly ok: boolean;
  /** How long the answer is, in characters; the answer itself stays here. */
  readonly chars: number;
  readonly error?: string;
  readonly ms: number;
  /** The tokens it took, when the assistant counted them (never a guess). */
  readonly usage?: { readonly model: string; readonly inputTokens: number; readonly outputTokens: number; readonly cachedTokens: number };
}

export interface Guard {
  readonly name: string;
  /** Never throws: a guard that can't decide says block. */
  check(handOff: HandOff): Promise<Verdict>;
  /** Never throws. */
  report(handOff: HandOff, outcome: Outcome): Promise<void>;
  /** The run is over: let go of whatever was kept for it. Never throws. */
  finish(runId: string, state: RunState): Promise<void>;
  /** Waits for the guard's own approver to decide a hold it filed (Verdict.heldBy). Never throws. */
  awaitRelease?(heldBy: HeldBy): Promise<"approved" | "rejected" | "timeout">;
}
