import { z } from "zod";

/**
 * A flow file: the assistants it uses and the steps that hand work between them. Checked when a flow
 * is loaded, so a typo fails with a message instead of halfway through a run.
 */

const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i, "use letters, numbers, - and _ (up to 64)");
/** Where a step goes next: another step's id, or "end". */
const target = z.string().min(1);

/** A plain email address. */
export const EMAIL_PATTERN = /^[^\s@<>,;"]+@[^\s@<>,;".]+(?:\.[^\s@<>,;".]+)+$/;
const emailAddress = z.string().max(254).regex(EMAIL_PATTERN, "an email address, like you@example.com");

/** The agent CLIs the cli connector can run on this computer, each in its careful mode. */
export const CLI_AGENTS = ["claude", "codex", "opencode"] as const;
export type CliAgent = (typeof CLI_AGENTS)[number];
/** A model name as these CLIs take it ("sonnet", "gpt-5.5", "openai/gpt-5.4-mini", "opus[1m]"): nothing a shell would read. */
const CLI_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;

export const Assistant = z.object({
  id,
  name: z.string().optional(),
  /** What it's good at, in a sentence: what the router's judge reads to pick it. */
  description: z.string().max(500).optional(),
  /** How to reach it: openclaw and hermes are A2A with their usual local address filled in. */
  connector: z.enum(["mock", "http", "sochen", "a2a", "openclaw", "hermes", "openai", "ollama", "vllm", "cli", "openshell", "pact", "homeassistant", "agentzero", "instinct", "email", "monid"]),
  /** The slices of shared memory this assistant may read. */
  memory: z.array(z.string().min(1)).default([]),
  /** http: where to POST. a2a: the agent's base address or its card. openai: the API base. sochen: if not https://sochen.dev. instinct: if not http://127.0.0.1:8080. */
  url: z.string().url().optional(),
  /** The environment variable that holds this assistant's key. Never the key itself. */
  keyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "an environment variable name, like SOCHEN_API_KEY").optional(),
  /** homeassistant: which conversation agent; agentzero: which agent profile; openshell: which sandbox; cli: which agent CLI. */
  agentId: z.string().min(1).optional(),
  /** openai, ollama, vllm, cli: the model to ask for (e.g. "openclaw/main" for an OpenClaw agent, what vLLM serves, or "sonnet" for Claude Code). */
  model: z.string().min(1).optional(),
  /** pact: the audience the business's Provider gave Huddle when it registered (goes in each token's aud). */
  audience: z.string().min(1).optional(),
  /** pact: what to ask the business to let Huddle do for you (scope ids from its Agent Card), signed in once. */
  scopes: z.array(z.string().min(1).max(100)).max(50).optional(),
  /** openshell: the command that runs the agent in its sandbox; the request goes in on stdin, or where "{{ask}}" is. */
  command: z.array(z.string().min(1)).min(1).max(64).optional(),
  /**
   * What it charges, in US dollars: per million tokens in (input), from the provider's prompt cache (cached)
   * and out (output), plus per call. Leave it out when you don't know; stand-ins and Ollama on this machine
   * are free. The router uses it to pick the cheaper of assistants that fit about as well.
   */
  price: z
    .object({
      input: z.number().min(0).max(10_000).default(0),
      output: z.number().min(0).max(10_000).default(0),
      cached: z.number().min(0).max(10_000).optional(),
      call: z.number().min(0).max(1_000).default(0),
    })
    .optional(),
  /** openai, ollama, vllm: the most an answer may run to, in tokens (a cap on what one answer can cost). */
  maxTokens: z.number().int().min(1).max(1_000_000).optional(),
  /** Router: answer the very same ask again from the last answer, for this many minutes. Only for answers safe to reuse. */
  reuseMinutes: z.number().int().min(1).max(10_080).optional(),
  /** mock: fixed answers; the first key found in the request (ignoring case) wins, then "*". */
  replies: z.record(z.string(), z.string()).optional(),
  /** email: who it goes to, always these addresses (up to 50), so a step can't be talked into mailing someone else. */
  to: z.array(emailAddress).min(1).max(50).optional(),
  /** email: who it's from, an address on a domain you verified in Resend; "Name <address>" works too. */
  from: z
    .string()
    .max(320)
    .refine((value) => EMAIL_PATTERN.test(value) || EMAIL_PATTERN.test(/^[^<>]*<([^<>]+)>$/.exec(value.trim())?.[1] ?? ""), 'an email address, or "Name <address>"')
    .optional(),
  /** monid: the tool, as its provider and endpoint in Monid's catalog (find one with `huddle monid find`), like "dataforseo/serp/google-jobs". */
  tool: z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9][\w.-]*\/\S+$/, 'a Monid tool, as provider/endpoint, like "dataforseo/serp/google-jobs"')
    .optional(),
  /** monid: the tool's input as Monid takes it ({ "body": … } or { "queryParams": … }); "{{ask}}" anywhere in its text becomes the step's request. */
  input: z.record(z.string(), z.unknown()).optional(),
  /** monid: the most one run may cost, in US dollars (0.10 when left out). A tool Monid can't price ahead runs only with this set. */
  maxUsd: z.number().min(0).max(100).optional(),
  /** monid: how long a run waits for a slow tool before giving up on it, in seconds (120 when left out). */
  waitSeconds: z.number().int().min(5).max(600).optional(),
});
export type Assistant = z.infer<typeof Assistant>;

/** What a connector needs that the shape alone can't say, one line each. */
export function assistantProblems(assistant: Assistant): string[] {
  const problems: string[] = [];
  if (assistant.connector === "email" && (!assistant.to || !assistant.from)) {
    problems.push(`assistant "${assistant.id}" sends email: give who it goes to (to) and who it's from (from, on a domain you verified in Resend)`);
  }
  if (assistant.connector === "vllm" && !assistant.model) {
    problems.push(`assistant "${assistant.id}" is a model served by vLLM: give the model's name as vLLM serves it (model)`);
  }
  if (assistant.connector === "cli") {
    if (!(CLI_AGENTS as readonly string[]).includes(assistant.agentId ?? "")) {
      problems.push(`assistant "${assistant.id}" is an agent CLI on this computer: say which one (agentId): ${CLI_AGENTS.join(", ")}`);
    }
    if (assistant.model !== undefined && !CLI_MODEL.test(assistant.model)) {
      problems.push(`assistant "${assistant.id}": a model name for an agent CLI is letters, numbers and . _ : / @ - [ ] (like "sonnet" or "gpt-5.5")`);
    }
  }
  if (assistant.connector === "openshell" && (!assistant.agentId || !assistant.command)) {
    problems.push(`assistant "${assistant.id}" runs in OpenShell: give its sandbox's name (agentId) and the command that runs its agent (command)`);
  }
  if (assistant.connector === "monid" && !assistant.tool) {
    problems.push(`assistant "${assistant.id}" is a Monid tool: say which one (tool), as provider/endpoint; \`huddle monid find\` lists them`);
  }
  if (assistant.connector === "pact" && (!assistant.url || !assistant.audience)) {
    problems.push(`assistant "${assistant.id}" is a business's agent over PACT: give its Agent Card URL (url) and the Provider's audience (audience)`);
  }
  return problems;
}

/** Your assistants, set up once: the ones the router reaches by id. */
export const Assistants = z.array(Assistant).superRefine((assistants, ctx) => {
  const seen = new Set<string>();
  for (const assistant of assistants) {
    if (seen.has(assistant.id)) ctx.addIssue({ code: "custom", message: `two assistants are called "${assistant.id}"` });
    seen.add(assistant.id);
    for (const problem of assistantProblems(assistant)) ctx.addIssue({ code: "custom", message: problem });
  }
});

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

/** How long between scheduled runs: "15m", "2h", "1d" (at least 1 minute). */
const every = z.string().regex(/^[1-9]\d*(m|h|d)$/, 'use a number and m, h or d, like "15m", "2h" or "1d"');

export const Trigger = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }),
  /** Runs every so often, with `input` as the run's input. */
  z.object({ type: z.literal("schedule"), every, input: z.string().default("") }),
  /** Runs when something posts to the flow's webhook address (the server shows it); the body is the input. */
  z.object({ type: z.literal("webhook") }),
  /** Runs when mail to `address` reaches Huddle, through Resend's inbound webhook; the email is the input. */
  z.object({ type: z.literal("email"), address: emailAddress }),
]);
export type Trigger = z.infer<typeof Trigger>;

/**
 * How close someone is, after open-instinct's trust tiers: you ("owner"), then the people you name in
 * Contacts. Anyone else who reaches Huddle is a stranger.
 */
export const TIERS = ["owner", "partner", "family", "friend", "contact"] as const;
export type Tier = (typeof TIERS)[number];
/** The tiers a contact can have (owner is you). */
export const CONTACT_TIERS = ["partner", "family", "friend", "contact"] as const;
export type ContactTier = (typeof CONTACT_TIERS)[number];

/** Who reached Huddle: you, one of your contacts, or a stranger. */
export interface Caller {
  readonly tier: Tier | "stranger";
  readonly name: string;
  readonly contactId: string | null;
}

/** Who may start a flow from outside Huddle (another agent over A2A, an email). */
export const Callers = z.object({
  /** This tier and closer start the flow at once. */
  starts: z.enum(TIERS).default("owner"),
  /** Contacts further away: their run waits for your OK ("ask"), or they're turned away ("refuse"). */
  others: z.enum(["ask", "refuse"]).default("ask"),
  /** People who aren't in your contacts: turned away unless you let them ask. */
  strangers: z.enum(["ask", "refuse"]).default("refuse"),
});
export type Callers = z.infer<typeof Callers>;

/** Whether a caller may start the flow now, has to wait for your OK first, or is turned away. */
export function callerDecision(callers: Callers | undefined, tier: Tier | "stranger"): "start" | "ask" | "refuse" {
  const rules = Callers.parse(callers ?? {});
  if (tier === "stranger") return rules.strangers;
  return TIERS.indexOf(tier) <= TIERS.indexOf(rules.starts) ? "start" : rules.others;
}

/**
 * The flow with an approval in front: "<who> wants to run <flow> with: <input>". The run waits there
 * until you answer; a no ends it as declined. The input goes in as {{input}}, which is filled in once
 * and never read as a template itself.
 */
export function askFirst(flow: Flow, who: string): Flow {
  let id = "caller-check";
  while (flow.steps.some((step) => step.id === id)) id = `${id}-1`;
  const name = who.replace(/[{}]/g, "").trim() || "Someone";
  const first = flow.steps[0]?.id;
  return {
    ...flow,
    steps: [{ id, type: "approval", message: `${name} wants to run "${flow.name.replace(/[{}]/g, "")}" with: {{input}}`, ...(first ? { next: first } : {}) }, ...flow.steps],
  };
}

/** The milliseconds a schedule's "every" stands for. */
export function everyMs(value: string): number {
  const amount = Number.parseInt(value, 10);
  const unit = value.slice(-1);
  return amount * (unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000);
}

export const Flow = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    trigger: Trigger.default({ type: "manual" }),
    /** Who may start it from outside Huddle; without it, only you. */
    callers: Callers.optional(),
    assistants: z.array(Assistant).default([]),
    steps: z.array(Step).min(1),
    /** Where each step sits on the canvas; ignored by the engine. */
    ui: z.object({ positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).default({}) }).optional(),
  })
  .superRefine((flow, ctx) => {
    const steps = new Set<string>();
    for (const step of flow.steps) {
      if (steps.has(step.id)) ctx.addIssue({ code: "custom", message: `two steps are called "${step.id}"` });
      steps.add(step.id);
    }
    const assistants = new Set(flow.assistants.map((assistant) => assistant.id));
    for (const assistant of flow.assistants) for (const problem of assistantProblems(assistant)) ctx.addIssue({ code: "custom", message: problem });
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
