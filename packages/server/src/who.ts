import type { Flow } from "@huddle/core";

/** An assistant as the button and the canvas show it: its Huddler (or logo) comes from the id and connector. */
export interface Who {
  readonly id: string;
  readonly name: string;
  readonly connector: string;
}

export const whoOf = (assistant: { readonly id: string; readonly name?: string | undefined; readonly connector: string } | undefined): Who | null =>
  assistant ? { id: assistant.id, name: assistant.name ?? assistant.id, connector: assistant.connector } : null;

/** The assistant whose answer a flow says: its last assistant step's. */
export function answering(flow: Flow): Who | null {
  const last = flow.steps.findLast((step) => step.type === "agent");
  return last?.type === "agent" ? whoOf(flow.assistants.find((assistant) => assistant.id === last.agent)) : null;
}

/** Everyone a flow asks, in the order it asks them. */
export function teamOf(flow: Flow): Who[] {
  const ids = [...new Set(flow.steps.flatMap((step) => (step.type === "agent" ? [step.agent] : [])))];
  return ids.flatMap((id) => whoOf(flow.assistants.find((assistant) => assistant.id === id)) ?? []);
}

/** The assistant at a step of a flow, if that step asks one; no step means the first. */
export function workingAt(flow: Flow, stepId: string | null): Who | null {
  const step = stepId ? flow.steps.find((candidate) => candidate.id === stepId) : flow.steps[0];
  return step?.type === "agent" ? whoOf(flow.assistants.find((assistant) => assistant.id === step.agent)) : null;
}

/** A flow with a note before its last assistant step's ask (the one whose answer is the run's): never saved. */
export function withNote(flow: Flow, note: string): Flow {
  const last = flow.steps.findLast((step) => step.type === "agent");
  if (!last || last.type !== "agent") return flow;
  return { ...flow, steps: flow.steps.map((step) => (step === last ? { ...last, ask: `${note}\n\n${last.ask}` } : step)) };
}
