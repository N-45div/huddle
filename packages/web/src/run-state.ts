import type { RunView } from "./types.ts";

/** How a step stands in a run, for highlighting it. Steps the run hasn't reached have no entry. */
export type StepRunState = "done" | "current" | "waiting" | "failed";

export const STEP_STATE_LABEL: Record<StepRunState, string> = {
  done: "Done",
  current: "Working",
  waiting: "Waiting",
  failed: "Failed",
};

export function stepStates(run: RunView): Record<string, StepRunState> {
  const states: Record<string, StepRunState> = {};
  for (const id of Object.keys(run.context.steps)) states[id] = "done";
  if (run.at) {
    if (run.state === "running") states[run.at] = "current";
    else if (run.state === "waiting") states[run.at] = "waiting";
    else if (run.state === "failed") states[run.at] = "failed";
  }
  return states;
}

export function isFinished(run: RunView): boolean {
  return run.state === "done" || run.state === "declined" || run.state === "failed";
}
