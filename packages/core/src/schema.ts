import { z } from "zod";

/**
 * A flow file: the assistants it uses and the steps that hand work between them. Checked when a flow
 * is loaded, so a typo fails with a message instead of halfway through a run.
 */

const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i, "use letters, numbers, - and _ (up to 64)");
/** Where a step goes next: another step's id, or "end". */
const target = z.string().min(1);

export const Assistant = z.object({
  id,
  name: z.string().optional(),
  /** How to reach it: openclaw and hermes are A2A with their usual local address filled in. */
  connector: z.enum(["mock", "http", "sochen", "a2a", "openclaw", "hermes", "openai"]),
  /** The slices of shared memory this assistant may read. */
  memory: z.array(z.string().min(1)).default([]),
  /** http: where to POST. a2a: the agent's base address or its card. openai: the API base. sochen: if not https://sochen.dev. */
  url: z.string().url().optional(),
  /** The environment variable that holds this assistant's key. Never the key itself. */
  keyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "an environment variable name, like SOCHEN_API_KEY").optional(),
  /** openai: the model to ask for (e.g. "openclaw/main" for an OpenClaw agent). */
  model: z.string().min(1).optional(),
  /** mock: fixed answers; the first key found in the request (ignoring case) wins, then "*". */
  replies: z.record(z.string(), z.string()).optional(),
});
export type Assistant = z.infer<typeof Assistant>;

const AgentStep = z.object({
  id,
  type: z.literal("agent"),
  agent: id,
  ask: z.string().min(1),
  next: target.optional(),
});

const ConditionStep = z.object({
  id,
  type: z.literal("condition"),
  /** "<left> <op> <right>", e.g. "{{read.data.amount}} > 200". */
  if: z.string().min(1),
  then: target,
  else: target,
});

const ApprovalStep = z.object({
  id,
  type: z.literal("approval"),
  message: z.string().min(1),
  next: target.optional(),
  /** Where a "no" goes; without it, the run ends as declined. */
  onNo: target.optional(),
});

const MemoryStep = z.object({
  id,
  type: z.literal("memory"),
  slice: z.string().min(1),
  note: z.string().min(1),
  next: target.optional(),
});

export const Step = z.discriminatedUnion("type", [AgentStep, ConditionStep, ApprovalStep, MemoryStep]);
export type Step = z.infer<typeof Step>;

export const Flow = z
  .object({
    name: z.string().min(1),
    trigger: z.object({ type: z.literal("manual") }).default({ type: "manual" }),
    assistants: z.array(Assistant).default([]),
    steps: z.array(Step).min(1),
  })
  .superRefine((flow, ctx) => {
    const steps = new Set<string>();
    for (const step of flow.steps) {
      if (steps.has(step.id)) ctx.addIssue({ code: "custom", message: `two steps are called "${step.id}"` });
      steps.add(step.id);
    }
    const assistants = new Set(flow.assistants.map((assistant) => assistant.id));
    const check = (from: string, to: string | undefined) => {
      if (to !== undefined && to !== "end" && !steps.has(to)) ctx.addIssue({ code: "custom", message: `step "${from}" goes to "${to}", which isn't a step` });
    };
    for (const step of flow.steps) {
      if (step.type === "agent" && !assistants.has(step.agent)) ctx.addIssue({ code: "custom", message: `step "${step.id}" asks "${step.agent}", which isn't one of the flow's assistants` });
      if (step.type === "condition") {
        check(step.id, step.then);
        check(step.id, step.else);
      } else {
        check(step.id, step.next);
        if (step.type === "approval") check(step.id, step.onNo);
      }
    }
  });
export type Flow = z.infer<typeof Flow>;

/** A flow from parsed JSON, or an error listing what's wrong in plain words. */
export function parseFlow(input: unknown): Flow {
  const result = Flow.safeParse(input);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message));
  throw new Error(`This flow has problems:\n- ${problems.join("\n- ")}`);
}
