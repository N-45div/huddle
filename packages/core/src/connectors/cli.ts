import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Connector, dataIn, memoryText, type Reply } from "../connector.ts";
import type { Usage } from "../cost.ts";
import { CLI_AGENTS, type CliAgent } from "../schema.ts";

/**
 * An agent CLI on this computer, signed in as you already use it: Claude Code, Codex or OpenCode (the ones
 * Omarchy sets up, among others). Huddle asks it one thing at a time, with the request on stdin, in an empty
 * folder of its own, and in that CLI's careful mode, so it can't change anything on this computer: Claude
 * Code may only search the web; Codex reads (it can look at files) in its read-only sandbox; OpenCode answers
 * without tools. None of them gets your MCP servers, whose tools would run outside those limits. The
 * assistant names the CLI (agentId) and, if you like, its model.
 */

const TIMEOUT_MS = 600_000;
/** More than any answer needs; a CLI that prints without end is stopped. */
const MOST_OUTPUT = 8_000_000;

export interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly stdin: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/** Runs a program to the end; a missing program rejects with code "ENOENT". */
export type Runner = (command: string, args: readonly string[], options: RunOptions) => Promise<Ran>;

interface Preset {
  readonly name: string;
  readonly install: string;
  /** Said after a failure when the assistant names no model. */
  readonly noModel?: string;
  readonly args: (model: string | undefined) => string[];
  readonly env?: Readonly<Record<string, string>>;
  /** The answer and its tokens from what the CLI printed; throws with the CLI's own words when it failed. */
  readonly read: (stdout: string) => { text: string; usage?: Usage };
}

const PRESETS: Readonly<Record<CliAgent, Preset>> = {
  claude: {
    name: "Claude Code",
    install: "Install Claude Code (npm i -g @anthropic-ai/claude-code, or Install > AI on Omarchy) and sign in once with: claude",
    // Web search is its one tool, allowed up front (dontAsk turns down anything else); --tools limits only its
    // own tools, and --strict-mcp-config (with no config given) drops every MCP server too.
    args: (model) => [
      "-p",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--permission-mode",
      "dontAsk",
      "--tools",
      "WebSearch",
      "--allowedTools",
      "WebSearch",
      "--strict-mcp-config",
      ...(model ? ["--model", model] : []),
    ],
    read(stdout) {
      const result = lastJson(stdout) as {
        is_error?: unknown;
        subtype?: unknown;
        result?: unknown;
        usage?: { input_tokens?: unknown; output_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown };
      } | null;
      // Nothing printed: its exit code and error output say why.
      if (!result) return { text: "" };
      if (result.is_error === true || (typeof result.subtype === "string" && result.subtype !== "success")) {
        throw new Error(words(result.result) ?? `stopped (${words(result.subtype) ?? "error"}).`);
      }
      const usage = result.usage;
      const cached = num(usage?.cache_read_input_tokens);
      const input = num(usage?.input_tokens) + num(usage?.cache_creation_input_tokens) + cached;
      return {
        text: typeof result.result === "string" ? result.result : "",
        ...(usage ? { usage: { inputTokens: input, outputTokens: num(usage.output_tokens), ...(cached ? { cachedTokens: cached } : {}) } } : {}),
      };
    },
  },
  codex: {
    name: "Codex",
    install: "Install Codex (npm i -g @openai/codex, or Install > AI on Omarchy) and sign in once with: codex",
    noModel: "Huddle leaves out Codex's config.toml, so this was Codex's built-in default model: give the assistant a model your plan includes, like gpt-5.5.",
    // Its config.toml is left out (sign-in still works): its MCP servers would run outside the sandbox.
    args: (model) => ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--sandbox", "read-only", "--color", "never", ...(model ? ["-m", model] : []), "-"],
    read(stdout) {
      let text = "";
      let usage: Usage | undefined;
      let failure = "";
      for (const event of jsonLines(stdout)) {
        const item = event.item as { type?: unknown; text?: unknown } | undefined;
        if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") text = item.text;
        if (event.type === "turn.completed") {
          const used = event.usage as { input_tokens?: unknown; cached_input_tokens?: unknown; output_tokens?: unknown } | undefined;
          const cached = num(used?.cached_input_tokens);
          usage = { inputTokens: num(used?.input_tokens), outputTokens: num(used?.output_tokens), ...(cached ? { cachedTokens: cached } : {}) };
        }
        if (event.type === "error" && typeof event.message === "string") failure = event.message;
        if (event.type === "turn.failed") failure = words((event.error as { message?: unknown } | undefined)?.message) ?? failure;
      }
      if (!text && failure) throw new Error(said(failure));
      return { text, ...(usage ? { usage } : {}) };
    },
  },
  opencode: {
    name: "OpenCode",
    install: "Install OpenCode (npm i -g opencode-ai, or Install > AI on Omarchy) and sign in to a provider once with: opencode auth login",
    args: (model) => ["run", "--format", "json", ...(model ? ["-m", model] : [])],
    // No tools at all (MCP servers' included); editing and commands refused as well, in case a tool slips through.
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { edit: "deny", bash: "deny" }, tools: { "*": false } }) },
    read(stdout) {
      let step: string[] = [];
      let answer: string[] = [];
      let input = 0;
      let output = 0;
      let cached = 0;
      let counted = false;
      for (const event of jsonLines(stdout)) {
        const part = event.part as { text?: unknown; tokens?: { input?: unknown; output?: unknown; cache?: { read?: unknown } } } | undefined;
        if (event.type === "step_start") step = [];
        if (event.type === "text" && typeof part?.text === "string") step.push(part.text);
        if (event.type === "step_finish") {
          if (step.length) answer = step;
          if (part?.tokens) {
            counted = true;
            cached += num(part.tokens.cache?.read);
            input += num(part.tokens.input) + num(part.tokens.cache?.read);
            output += num(part.tokens.output);
          }
        }
        if (event.type === "error") {
          const error = event.error as { name?: unknown; data?: { message?: unknown } } | undefined;
          throw new Error(said(words(error?.data?.message, error?.name) ?? "failed"));
        }
      }
      if (step.length) answer = step;
      return { text: answer.join(""), ...(counted ? { usage: { inputTokens: input, outputTokens: output, ...(cached ? { cachedTokens: cached } : {}) } } : {}) };
    },
  },
};

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
/** The first of these that is some text. */
const words = (...values: unknown[]): string | undefined => values.find((value): value is string => typeof value === "string" && value.length > 0);

function* jsonLines(text: string): Generator<Record<string, unknown>> {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (value && typeof value === "object") yield value as Record<string, unknown>;
    } catch {
      // Not one of its events.
    }
  }
}

function lastJson(text: string): unknown {
  let last: unknown = null;
  for (const event of jsonLines(text)) last = event;
  return last;
}

/** A provider's error often arrives as JSON inside the message; its own sentence is what to show. */
function said(message: string): string {
  try {
    const parsed = JSON.parse(message) as { error?: { message?: unknown }; message?: unknown };
    const inner = parsed.error?.message ?? parsed.message;
    if (typeof inner === "string" && inner) return inner;
  } catch {
    // Already a sentence.
  }
  return message;
}

/** The last few lines of a program's error output, for an error message. */
const tail = (text: string) => text.trim().split("\n").slice(-6).join("\n").slice(-800);

/**
 * What ties a process to the Claude Code session it was started from (with that session's own token): a
 * Huddle started in a Claude Code terminal mustn't hand it on, or each agent it asks would join that session.
 */
const SESSION_TIES = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_PID",
  "CLAUDE_AGENT_SDK_VERSION",
  "AI_AGENT",
]);

/** This server's own settings, and any session it was started from, stay out of the agent's environment. */
function agentEnv(extra: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (!name.startsWith("HUDDLE_") && !SESSION_TIES.has(name)) env[name] = value;
  return { ...env, NO_COLOR: "1", ...extra };
}

export function cli(runner: Runner = runProgram): Connector {
  return {
    async send({ assistant, ask, memory, signal }): Promise<Reply> {
      const agent = assistant.agentId as CliAgent | undefined;
      const preset = agent && (CLI_AGENTS as readonly string[]).includes(agent) ? PRESETS[agent] : undefined;
      if (!preset) throw new Error(`Assistant "${assistant.id}" needs which agent CLI to run (agentId): ${CLI_AGENTS.join(", ")}.`);
      const who = `${assistant.id} (${preset.name})`;
      const text = memory.length ? `${ask}\n\nWhat you may use about me:\n${memoryText(memory)}` : ask;
      const folder = await mkdtemp(join(tmpdir(), "huddle-agent-"));
      let ran: Ran;
      try {
        ran = await runner(agent!, preset.args(assistant.model), { stdin: text, cwd: folder, env: agentEnv(preset.env), timeoutMs: TIMEOUT_MS, signal });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${who}: ${agent} isn't installed where Huddle runs. ${preset.install}`);
        if ((error as Error).name === "TimeoutError") throw new Error(`${who} didn't answer within ${TIMEOUT_MS / 60_000} minutes.`);
        throw error;
      } finally {
        await rm(folder, { recursive: true, force: true }).catch(() => {});
      }
      let read: { text: string; usage?: Usage };
      try {
        read = preset.read(ran.stdout);
      } catch (error) {
        const hint = !assistant.model && preset.noModel ? ` ${preset.noModel}` : "";
        throw new Error(`${who} said: ${(error as Error).message}${hint}`);
      }
      const answer = read.text.trim();
      if (!answer) {
        const why = tail(ran.stderr) || tail(ran.stdout);
        throw new Error(ran.code ? `${who} stopped with exit code ${ran.code}${why ? `: ${why}` : "."}` : `${who} finished without an answer.`);
      }
      const data = dataIn(answer);
      return { text: answer, ...(data === undefined ? {} : { data }), ...(read.usage ? { usage: read.usage } : {}) };
    },
  };
}

/**
 * Runs a program with the request on stdin. On Windows the CLIs are npm's .cmd shims, which only a shell
 * runs; every argument is a fixed word or a checked model name, so the shell has nothing to interpret.
 */
export const runProgram: Runner = (command, args, { stdin, cwd, env, timeoutMs, signal }) =>
  new Promise((resolve, reject) => {
    const windows = process.platform === "win32";
    const child = spawn(command, args, { cwd, env, shell: windows, detached: !windows, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    /** Why it was stopped; the promise settles once it has gone (it may hold its folder until then). */
    let stopped: Error | null = null;
    const stop = () => {
      if (child.pid === undefined || child.exitCode !== null) return;
      try {
        // The CLI's own helpers go with it.
        if (windows) spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
        else process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    };
    const finish = (error: Error | null, ran?: Ran) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve(ran!);
    };
    const halt = (why: Error) => {
      if (stopped || settled) return;
      stopped = why;
      stop();
      // In case it never says it has gone.
      setTimeout(() => finish(why), 5_000).unref();
    };
    const timer = setTimeout(() => halt(Object.assign(new Error("timed out"), { name: "TimeoutError" })), timeoutMs);
    const aborted = () => halt(signal?.reason instanceof Error ? signal.reason : Object.assign(new Error("stopped"), { name: "AbortError" }));
    if (signal?.aborted) aborted();
    else signal?.addEventListener("abort", aborted, { once: true });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MOST_OUTPUT) halt(new Error(`printed more than ${MOST_OUTPUT / 1_000_000} MB.`));
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-64_000);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (stopped) return finish(stopped);
      // Through a Windows shell a missing program is cmd's complaint, not ENOENT.
      if (windows && code !== 0 && /is not recognized as an internal or external command/i.test(stderr)) {
        finish(Object.assign(new Error(`${command} not found`), { code: "ENOENT" }));
      } else {
        finish(null, { code, stdout, stderr });
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
