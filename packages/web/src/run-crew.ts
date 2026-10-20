import type { Flow, LogLine, RunDetail } from "./types.ts";

/**
 * Who's on a run, for the run page: the run itself, then each hand-off to an assistant, each time it needed
 * you, the voice that started it and what Huddle learned after, in the order they happened. Under a row: what
 * it fanned out to (an approval's fact check) and earlier tries of a step that failed and was tried again.
 * Built from the run's log alone, so it's the same live or afterwards.
 */

export type CrewStatus = "running" | "done" | "needs-you" | "failed" | "stopped" | "declined";
export type CrewKind = "run" | "assistant" | "you" | "facts" | "learning" | "voice";
/** What a row's small icons say it touched. */
export type ToolMark = "memory" | "image" | "web" | "sandbox" | "mail" | "mic" | "business" | "tools";

export interface CrewNode {
  readonly key: string;
  readonly kind: CrewKind;
  readonly name: string;
  /** The model or service doing it: "Nemotron 3 Super", "Tavily · Nemotron 3 Super". */
  readonly by: string;
  /** Whose Huddler to draw (an assistant's id and connector); none for Hud. */
  readonly avatar: { readonly id?: string; readonly connector?: string };
  readonly task: string;
  readonly tools: readonly ToolMark[];
  readonly status: CrewStatus;
  /** What it cost, where that's known. */
  readonly costUsd: number | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly error: string | null;
  /** The approval to answer, while it needs you. */
  readonly approvalId: string | null;
  readonly children: readonly CrewNode[];
}

const CONNECTORS: Record<string, string> = {
  mock: "Stand-in",
  http: "Your service",
  sochen: "Sochen",
  a2a: "A2A agent",
  openclaw: "OpenClaw",
  hermes: "Hermes",
  openai: "OpenAI-compatible",
  ollama: "Ollama",
  vllm: "vLLM",
  nebius: "Nemotron",
  tavily: "Tavily",
  contextdev: "context.dev",
  cli: "Command line",
  openshell: "OpenShell sandbox",
  pact: "PACT",
  homeassistant: "Home Assistant",
  agentzero: "Agent Zero",
  instinct: "open-instinct",
  email: "Email",
  monid: "Monid",
};

const UPPER = new Set(["gpt", "glm", "vl", "oss", "nvidia", "asr", "tts"]);

/** A model id people can read: "nvidia/nemotron-3-super-120b-a12b" is "Nemotron 3 Super". */
export function modelName(model: string): string {
  const base = (model.split("/").pop() ?? model).replace(/(\d)_(\d)/g, "$1.$2");
  const words = base
    .split(/[-_\s]+/)
    .filter(Boolean)
    .filter((word) => !/^a?\d+(\.\d+)?[bm]$/i.test(word))
    .filter((word, index) => !(index === 0 && word.toLowerCase() === "nvidia"));
  return words.map((word) => (UPPER.has(word.toLowerCase()) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1))).join(" ") || model;
}

/** What an assistant's connector reaches, as an icon. */
const CONNECTOR_TOOL: Record<string, ToolMark> = { tavily: "web", contextdev: "web", openshell: "sandbox", email: "mail", pact: "business", monid: "tools" };

/** Any "vendor/model" ids inside a line, made readable. */
const readableModels = (text: string): string => text.replace(/\b[\w.-]+\/[\w.-]+\b/g, (id) => modelName(id));

/**
 * A line of text as a row shows it: markdown's marks and a table's pipes taken out, on one line. Simple
 * patterns and a split, no nested repeats, so a long message can't make the page stall.
 */
export function plain(value: string): string {
  const flat = value
    .replace(/```[^`]*```/g, " ")
    .replace(/:?-{3,}:?/g, " ")
    .replace(/[*_`#>~]+/g, "")
    .replaceAll("|", "·");
  return flat
    .split("·")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" · ");
}

/** An assistant's name without a trailing "(model)": the card says the model underneath. */
const shortName = (name: string): string => name.replace(/\s*\([^()]*\)\s*$/, "") || name;

const field = (detail: unknown, key: string): unknown => (detail && typeof detail === "object" ? (detail as Record<string, unknown>)[key] : undefined);
const text = (detail: unknown, key: string): string => {
  const value = field(detail, key);
  return typeof value === "string" ? value : "";
};
const number = (detail: unknown, key: string): number | null => {
  const value = field(detail, key);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

/** One try at an agent step: from its "asked" to its answer, its failure, or now. */
interface Attempt {
  readonly asked: LogLine | null;
  readonly lines: LogLine[];
}

function attemptsOf(lines: readonly LogLine[]): Attempt[] {
  const attempts: Attempt[] = [];
  let current: Attempt = { asked: null, lines: [] };
  for (const line of lines) {
    if (line.kind === "asked") {
      if (current.asked || current.lines.length) attempts.push(current);
      current = { asked: line, lines: [] };
    } else current.lines.push(line);
  }
  attempts.push(current);
  // A hold before the first try (a guard asked you) belongs with that try.
  if (attempts.length > 1 && !attempts[0]!.asked) {
    const [held, first, ...rest] = attempts;
    return [{ asked: first!.asked, lines: [...held!.lines, ...first!.lines] }, ...rest];
  }
  return attempts;
}

export function crewOf(detail: Pick<RunDetail, "run" | "flow" | "log">): CrewNode {
  const { run, flow, log } = detail;
  const live = run.state === "running" || run.state === "waiting";
  const steps = new Map<string, LogLine[]>();
  for (const line of log) {
    if (line.stepId === "trigger" || line.stepId === "learn" || line.stepId === "voice") continue;
    steps.set(line.stepId, [...(steps.get(line.stepId) ?? []), line]);
  }
  const before = (line: LogLine): string => log[Math.max(0, log.indexOf(line) - 1)]?.at ?? line.at;
  // The step being worked on: the run says which once it's moved on from its first, the log says before that.
  const current = live ? (run.at ?? log.findLast((line) => steps.has(line.stepId))?.stepId ?? null) : null;

  const children: CrewNode[] = [];
  const heard = log.find((line) => line.kind === "heard");
  if (heard) {
    const seconds = number(heard.detail, "seconds");
    children.push({
      key: "voice",
      kind: "voice",
      name: "Your voice",
      by: readableModels(text(heard.detail, "by")) || "Speech",
      avatar: { connector: "voice" },
      task: `${seconds === null ? "Heard you" : `Heard ${seconds}s of you`}${field(heard.detail, "local") === true ? ", on this machine" : ""}`,
      tools: ["mic"],
      status: "done",
      costUsd: null,
      startedAt: before(heard),
      endedAt: heard.at,
      error: null,
      approvalId: null,
      children: [],
    });
  }

  for (const [stepId, lines] of steps) {
    const step = flow.steps.find((candidate) => candidate.id === stepId);
    if (step?.type === "agent") children.push(assistantNode(flow, run, step.id, step.agent, lines, current === step.id));
    else if (step?.type === "approval") children.push(approvalNode(run, step.id, step.message, lines, before));
    // Conditions and memory steps are the flow's own logic, not someone working: the run's log shows them.
  }

  const learned = log.find((line) => line.kind === "learned");
  if (learned) {
    const notes = field(learned.detail, "notes");
    const count = Array.isArray(notes) ? notes.length : 0;
    const error = text(learned.detail, "error");
    children.push({
      key: "learning",
      kind: "learning",
      name: "Learning",
      by: readableModels(text(learned.detail, "by")) || "Memory",
      avatar: { id: "learning", connector: "nebius" },
      task: error ? "Couldn't read what you said" : count ? `Suggested ${count} note${count === 1 ? "" : "s"} for your memory` : "Nothing new to remember",
      tools: ["memory"],
      status: error ? "failed" : "done",
      costUsd: number(learned.detail, "costUsd"),
      startedAt: before(learned),
      endedAt: learned.at,
      error: error || null,
      approvalId: null,
      children: [],
    });
  }

  const started = log.find((line) => line.kind === "started");
  const all = (nodes: readonly CrewNode[]): CrewNode[] => nodes.flatMap((node) => [node, ...all(node.children)]);
  const costs = all(children).flatMap((node) => (node.costUsd === null ? [] : [node.costUsd]));
  const input = run.context.input.trim();
  return {
    key: "run",
    kind: "run",
    name: flow.name,
    by: started ? `From ${text(started.detail, "name") || "a trigger"}` : "Started by you",
    avatar: {},
    task: input ? plain(input).slice(0, 200) : (flow.description ?? "No input"),
    tools: run.context.images?.length ? ["image"] : [],
    status: run.state === "running" ? "running" : run.state === "waiting" ? "needs-you" : run.state === "done" ? "done" : run.state === "declined" ? "declined" : "failed",
    costUsd: costs.length ? costs.reduce((sum, cost) => sum + cost, 0) : null,
    startedAt: run.createdAt,
    endedAt: live ? null : run.updatedAt,
    error: run.error,
    approvalId: run.state === "waiting" ? (run.waiting?.id ?? null) : null,
    children,
  };
}

function assistantNode(flow: Flow, run: Pick<RunDetail["run"], "state" | "at" | "waiting">, stepId: string, agentId: string, lines: readonly LogLine[], working: boolean): CrewNode {
  const assistant = flow.assistants.find((candidate) => candidate.id === agentId);
  const by = assistant?.model ? modelName(assistant.model) : (CONNECTORS[assistant?.connector ?? ""] ?? assistant?.connector ?? "Assistant");
  const attempts = attemptsOf(lines);
  const nodes = attempts.map((attempt, index): CrewNode => {
    const last = index === attempts.length - 1;
    const answered = attempt.lines.find((line) => line.kind === "answered");
    const failed = attempt.lines.find((line) => line.kind === "failed");
    const declined = attempt.lines.find((line) => line.kind === "declined" || line.kind === "refused");
    const waiting = attempt.lines.findLast((line) => line.kind === "waiting");
    const held = waiting && !attempt.lines.some((line) => line.at >= waiting.at && (line.kind === "approved" || line.kind === "released" || line.kind === "declined" || line.kind === "refused")) && !attempt.asked;
    let status: CrewStatus;
    if (answered) status = "done";
    else if (failed) status = last ? "failed" : "stopped";
    else if (declined) status = "declined";
    else if (held && run.state === "waiting" && run.at === stepId) status = "needs-you";
    else status = working && last ? "running" : "stopped";
    const ended = answered ?? failed ?? declined ?? null;
    const cost = answered ? number(field(answered.detail, "cost"), "costUsd") : null;
    return {
      key: `${stepId}#${index}`,
      kind: "assistant",
      name: shortName(assistant?.name ?? agentId),
      by,
      avatar: { id: agentId, ...(assistant ? { connector: assistant.connector } : {}) },
      task: plain(attempt.asked ? text(attempt.asked.detail, "ask") : held ? text(waiting.detail, "message") : ""),
      tools: [
        ...(Array.isArray(field(attempt.asked?.detail, "memory")) && (field(attempt.asked?.detail, "memory") as unknown[]).length ? (["memory"] as const) : []),
        ...(number(attempt.asked?.detail, "images") ? (["image"] as const) : []),
        ...(assistant && CONNECTOR_TOOL[assistant.connector] ? [CONNECTOR_TOOL[assistant.connector]!] : []),
      ],
      status,
      costUsd: cost,
      startedAt: attempt.asked?.at ?? attempt.lines[0]?.at ?? "",
      endedAt: ended?.at ?? null,
      error: failed ? text(failed.detail, "error") : null,
      approvalId: status === "needs-you" ? (run.waiting?.id ?? null) : null,
      children: [],
    };
  });
  const latest = nodes.at(-1)!;
  // Earlier tries of a step tried again sit under the newest one, stopped.
  return { ...latest, key: stepId, children: nodes.slice(0, -1).reverse() };
}

function approvalNode(run: Pick<RunDetail["run"], "state" | "at" | "waiting">, stepId: string, message: string, lines: readonly LogLine[], before: (line: LogLine) => string): CrewNode {
  const waiting = lines.findLast((line) => line.kind === "waiting");
  const decided = lines.findLast((line) => line.kind === "approved" || line.kind === "declined");
  const children: CrewNode[] = [];
  const checked = lines.find((line) => line.kind === "fact-checked");
  const unchecked = lines.find((line) => line.kind === "unchecked");
  if (checked) {
    const facts = number(checked.detail, "facts") ?? 0;
    const counts = [
      [number(checked.detail, "supported") ?? 0, "confirmed"],
      [number(checked.detail, "contradicted") ?? 0, "contradicted"],
      [number(checked.detail, "unclear") ?? 0, "unclear"],
    ] as const;
    children.push({
      key: `${stepId}:facts`,
      kind: "facts",
      name: "Fact check",
      by: ((by) => (!by ? "Tavily" : /tavily/i.test(by) ? by : `Tavily · ${by}`))(readableModels(text(checked.detail, "by"))),
      avatar: { id: "fact-check", connector: "tavily" },
      tools: ["web"],
      task: facts ? `${facts} fact${facts === 1 ? "" : "s"} checked on the web: ${counts.filter(([count]) => count > 0).map(([count, word]) => `${count} ${word}`).join(", ")}` : "Nothing in it the web could check",
      status: "done",
      costUsd: number(checked.detail, "costUsd"),
      startedAt: before(checked),
      endedAt: checked.at,
      error: null,
      approvalId: null,
      children: [],
    });
  } else if (unchecked) {
    children.push({
      key: `${stepId}:facts`,
      kind: "facts",
      name: "Fact check",
      by: "Tavily",
      avatar: { id: "fact-check", connector: "tavily" },
      task: text(unchecked.detail, "reason"),
      tools: ["web"],
      status: "stopped",
      costUsd: null,
      startedAt: before(unchecked),
      endedAt: unchecked.at,
      error: null,
      approvalId: null,
      children: [],
    });
  }
  const needsYou = !decided && run.state === "waiting" && run.at === stepId;
  return {
    key: stepId,
    kind: "you",
    name: "You",
    by: "Your OK",
    avatar: {},
    task: plain(waiting ? text(waiting.detail, "message") : message),
    tools: [],
    status: decided ? (decided.kind === "approved" ? "done" : "declined") : needsYou ? "needs-you" : "stopped",
    costUsd: null,
    startedAt: waiting?.at ?? lines[0]?.at ?? "",
    endedAt: decided?.at ?? null,
    error: null,
    approvalId: needsYou ? (run.waiting?.id ?? null) : null,
    children,
  };
}

/** Every card in the tree, the run's own first. */
export function nodesOf(root: CrewNode): CrewNode[] {
  return [root, ...root.children.flatMap((child) => nodesOf(child))];
}

/** "45s", "1m 09s", "2h 05m". */
export function elapsed(startedAt: string, endedAt: string | null, now = Date.now()): string {
  const from = Date.parse(startedAt);
  const to = endedAt ? Date.parse(endedAt) : now;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return "";
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
