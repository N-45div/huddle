import { type Flow, turnsOf } from "@huddle/core";

/** An assistant as the button and the canvas show it: its Huddler (or logo) comes from the id and connector. */
export interface Who {
  readonly id: string;
  readonly name: string;
  readonly connector: string;
}

export const whoOf = (assistant: { readonly id: string; readonly name?: string | undefined; readonly connector: string } | undefined): Who | null =>
  assistant ? { id: assistant.id, name: assistant.name ?? assistant.id, connector: assistant.connector } : null;

const assistantOf = (flow: Flow, id: string): Who | null => whoOf(flow.assistants.find((assistant) => assistant.id === id));

/** The last step that asks anyone: an agent step, or a together step (whose answer is all of theirs). */
const lastAsking = (flow: Flow) => flow.steps.findLast((step) => step.type === "agent" || step.type === "together");

/** The assistant whose answer a flow says: its last assistant step's. A flow that ends with several at once has none. */
export function answering(flow: Flow): Who | null {
  const last = lastAsking(flow);
  return last?.type === "agent" ? assistantOf(flow, last.agent) : null;
}

/** Everyone a flow asks, in the order it asks them (a together step's, in its order). */
export function teamOf(flow: Flow): Who[] {
  const ids = [...new Set(turnsOf(flow).map((turn) => turn.agent))];
  return ids.flatMap((id) => assistantOf(flow, id) ?? []);
}

/** The assistant at a step of a flow, if that step asks one (a together step: its first); no step means the first. */
export function workingAt(flow: Flow, stepId: string | null): Who | null {
  return workingNow(flow, stepId)[0] ?? null;
}

/**
 * Everyone working at a step of a flow right now: its assistant, or, at a together step, each of them that hasn't
 * finished (`finished` holds the ids of those that have). No step means the first.
 */
export function workingNow(flow: Flow, stepId: string | null, finished: ReadonlySet<string> = new Set()): Who[] {
  const step = stepId ? flow.steps.find((candidate) => candidate.id === stepId) : flow.steps[0];
  if (step?.type === "agent") return [assistantOf(flow, step.agent)].flatMap((who) => who ?? []);
  if (step?.type !== "together") return [];
  const ids = [...new Set(step.steps.filter((member) => !finished.has(member.id)).map((member) => member.agent))];
  return ids.flatMap((id) => assistantOf(flow, id) ?? []);
}

/**
 * A flow with a note before the ask whose answer is the run's (its last assistant step's; at a together step that
 * ends it, each one's): never saved.
 */
export function withNote(flow: Flow, note: string): Flow {
  const last = lastAsking(flow);
  if (!last) return flow;
  return {
    ...flow,
    steps: flow.steps.map((step) => {
      if (step !== last) return step;
      if (step.type === "agent") return { ...step, ask: `${note}\n\n${step.ask}` };
      if (step.type === "together") return { ...step, steps: step.steps.map((member) => ({ ...member, ask: `${note}\n\n${member.ask}` })) };
      return step;
    }),
  };
}
