/**
 * Filling {{...}} in a step from what the run knows: {{input}}, and each earlier step's answer as
 * {{stepId.text}} or {{stepId.data.field}}. A missing value fills in empty rather than failing, and
 * nothing is ever evaluated as code.
 */

export interface StepAnswer {
  readonly text: string;
  readonly data?: unknown;
}

export interface RunContext {
  readonly input: string;
  readonly steps: Readonly<Record<string, StepAnswer>>;
}

/** The value at a dotted path ("read.data.amount"), or undefined. */
export function lookup(context: RunContext, path: string): unknown {
  const [head, ...rest] = path.trim().split(".");
  let value: unknown = head === "input" ? context.input : head ? context.steps[head] : undefined;
  for (const key of rest) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function show(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // A whole answer ({{read}}) reads as its text.
  if (typeof value === "object" && "text" in value && typeof (value as StepAnswer).text === "string") return (value as StepAnswer).text;
  return JSON.stringify(value);
}

export function render(template: string, context: RunContext): string {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, path: string) => show(lookup(context, path)));
}
