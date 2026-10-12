import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { cli, type Ran, type RunOptions, runProgram } from "../src/connectors/cli.ts";
import { Assistant, assistantProblems } from "../src/schema.ts";
import type { Note } from "../src/store.ts";

const assistant = (fields: Record<string, unknown>) => Assistant.parse({ id: "mine", connector: "cli", ...fields });
const note = (slice: string, text: string) => ({ slice, note: text }) as Note;

/** A runner that records what it was asked to run, and prints what a real CLI printed. */
function recorder(print: string | ((options: RunOptions) => Ran)) {
  const calls: { command: string; args: readonly string[]; options: RunOptions; folderThen: boolean }[] = [];
  const runner = async (command: string, args: readonly string[], options: RunOptions): Promise<Ran> => {
    calls.push({ command, args, options, folderThen: existsSync(options.cwd) });
    return typeof print === "string" ? { code: 0, stdout: print, stderr: "" } : print(options);
  };
  return { calls, runner };
}

// What each CLI printed for "Reply with exactly: pong" (trimmed to the fields that matter).
const CLAUDE = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "pong", total_cost_usd: 0.045, usage: { input_tokens: 2, cache_creation_input_tokens: 5185, cache_read_input_tokens: 3587, output_tokens: 109 } });
const CODEX = [
  { type: "thread.started", thread_id: "01a1" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "pong" } },
  { type: "turn.completed", usage: { input_tokens: 16488, cached_input_tokens: 2432, output_tokens: 5, reasoning_output_tokens: 0 } },
]
  .map((event) => JSON.stringify(event))
  .join("\n");
const CODEX_REFUSED = [
  { type: "thread.started", thread_id: "01a1" },
  { type: "turn.started" },
  { type: "error", message: JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." } }) },
  { type: "turn.failed", error: { message: JSON.stringify({ type: "error", status: 400, error: { message: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." } }) } },
]
  .map((event) => JSON.stringify(event))
  .join("\n");
const OPENCODE = [
  { type: "step_start", part: { type: "step-start" } },
  { type: "text", part: { type: "text", text: "Let me check." } },
  { type: "tool_use", part: { type: "tool", tool: "websearch" } },
  { type: "step_finish", part: { type: "step-finish", tokens: { input: 900, output: 20, cache: { read: 100, write: 0 } } } },
  { type: "step_start", part: { type: "step-start" } },
  { type: "text", part: { type: "text", text: "pong" } },
  { type: "step_finish", part: { type: "step-finish", tokens: { input: 1000, output: 7, cache: { read: 0, write: 0 } } } },
]
  .map((event) => JSON.stringify(event))
  .join("\n");

describe("agent CLIs on this computer", () => {
  it("asks Claude Code in its careful mode, with the request and memory on stdin, in a folder of its own", async () => {
    const before = { ...process.env };
    Object.assign(process.env, { HUDDLE_TOKEN_FOR_TEST: "secret", CLAUDE_CODE_MESSAGING_TOKEN: "session-secret", CLAUDECODE: "1", CLAUDE_CODE_USE_BEDROCK: "1" });
    const { calls, runner } = recorder(CLAUDE);
    const reply = await cli(runner).send({ assistant: assistant({ agentId: "claude", model: "sonnet" }), ask: "Plan my day", memory: [note("work", "Standup at 9")] });
    for (const name of ["HUDDLE_TOKEN_FOR_TEST", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDECODE", "CLAUDE_CODE_USE_BEDROCK"]) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
    assert.equal(reply.text, "pong");
    assert.deepEqual(reply.usage, { inputTokens: 2 + 5185 + 3587, outputTokens: 109, cachedTokens: 3587 }, "the list-price cost isn't taken: a Claude plan doesn't pay it");
    const call = calls[0]!;
    assert.equal(call.command, "claude");
    assert.deepEqual(call.args, ["-p", "--output-format", "json", "--no-session-persistence", "--permission-mode", "dontAsk", "--tools", "WebSearch", "--allowedTools", "WebSearch", "--strict-mcp-config", "--model", "sonnet"]);
    assert.ok(!call.args.some((arg) => arg.includes("Plan my day")), "the request never goes on the command line");
    assert.match(call.options.stdin, /^Plan my day\n\nWhat you may use about me:\n- \(work\) Standup at 9$/);
    assert.ok(call.folderThen && !existsSync(call.options.cwd), "an empty folder of its own, removed afterwards");
    assert.equal(call.options.env.HUDDLE_TOKEN_FOR_TEST, undefined, "Huddle's own settings stay out of its environment");
    assert.deepEqual([call.options.env.CLAUDE_CODE_MESSAGING_TOKEN, call.options.env.CLAUDECODE], [undefined, undefined], "and so does the Claude Code session Huddle was started from");
    assert.equal(call.options.env.CLAUDE_CODE_USE_BEDROCK, "1", "the person's own Claude Code settings go through");
    assert.equal(call.options.env.NO_COLOR, "1");
  });

  it("runs Codex in its read-only sandbox without its config's MCP servers, and passes on what its provider said when it refuses", async () => {
    const { calls, runner } = recorder(CODEX);
    const reply = await cli(runner).send({ assistant: assistant({ agentId: "codex", model: "gpt-5.5" }), ask: "hi", memory: [] });
    assert.deepEqual([reply.text, reply.usage], ["pong", { inputTokens: 16488, outputTokens: 5, cachedTokens: 2432 }]);
    assert.deepEqual(calls[0]!.args, ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--sandbox", "read-only", "--color", "never", "-m", "gpt-5.5", "-"]);
    const refused = recorder(() => ({ code: 1, stdout: CODEX_REFUSED, stderr: "ERROR codex_models_manager::cache: failed to load models cache" }));
    await assert.rejects(cli(refused.runner).send({ assistant: assistant({ agentId: "codex", model: "gpt-6.1-sol" }), ask: "hi", memory: [] }), {
      message: "mine (Codex) said: The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.",
    });
    await assert.rejects(cli(refused.runner).send({ assistant: assistant({ agentId: "codex" }), ask: "hi", memory: [] }), /not supported .* Huddle leaves out Codex's config\.toml, so this was Codex's built-in default model: give the assistant a model your plan includes, like gpt-5\.5\./);
  });

  it("runs OpenCode without tools, and takes the last step's text as the answer", async () => {
    const { calls, runner } = recorder(OPENCODE);
    const reply = await cli(runner).send({ assistant: assistant({ agentId: "opencode", model: "openai/gpt-5.4-mini" }), ask: "hi", memory: [] });
    assert.deepEqual([reply.text, reply.usage], ["pong", { inputTokens: 2000, outputTokens: 27, cachedTokens: 100 }]);
    assert.deepEqual(calls[0]!.args, ["run", "--format", "json", "-m", "openai/gpt-5.4-mini"]);
    assert.deepEqual(JSON.parse(calls[0]!.options.env.OPENCODE_CONFIG_CONTENT!), { permission: { edit: "deny", bash: "deny" }, tools: { "*": false } });
    const failed = recorder(JSON.stringify({ type: "error", error: { name: "APIError", data: { message: "OpenCode's free tier can only be used from within OpenCode", statusCode: 403 } } }));
    await assert.rejects(cli(failed.runner).send({ assistant: assistant({ agentId: "opencode" }), ask: "hi", memory: [] }), /mine \(OpenCode\) said: OpenCode's free tier can only be used from within OpenCode/);
  });

  it("reads JSON answers as data, says how to install a missing CLI, and explains an exit without an answer", async () => {
    const json = recorder(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: '{"slots": 3}' }));
    assert.deepEqual((await cli(json.runner).send({ assistant: assistant({ agentId: "claude" }), ask: "hi", memory: [] })).data, { slots: 3 });
    const missing = async () => {
      throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    };
    await assert.rejects(cli(missing).send({ assistant: assistant({ agentId: "claude" }), ask: "hi", memory: [] }), /claude isn't installed where Huddle runs\. Install Claude Code .* sign in once with: claude/);
    const crashed = recorder(() => ({ code: 2, stdout: "", stderr: "line 1\nNot logged in. Run: claude" }));
    await assert.rejects(cli(crashed.runner).send({ assistant: assistant({ agentId: "claude" }), ask: "hi", memory: [] }), /mine \(Claude Code\) stopped with exit code 2: line 1\nNot logged in\. Run: claude/);
    const silent = recorder(() => ({ code: 3, stdout: CODEX.split("\n")[0]!, stderr: "Not signed in. Run: codex login" }));
    await assert.rejects(cli(silent.runner).send({ assistant: assistant({ agentId: "codex" }), ask: "hi", memory: [] }), /mine \(Codex\) stopped with exit code 3: Not signed in\. Run: codex login/);
  });

  it("only runs the CLIs it knows, with model names nothing could read as a command", () => {
    assert.match(assistantProblems(assistant({})).join(" "), /say which one \(agentId\): claude, codex, opencode/);
    assert.match(assistantProblems(assistant({ agentId: "bash" })).join(" "), /say which one/);
    assert.deepEqual(assistantProblems(assistant({ agentId: "claude", model: "opus[1m]" })), []);
    assert.deepEqual(assistantProblems(assistant({ agentId: "opencode", model: "openai/gpt-5.4-mini" })), []);
    for (const model of ["sonnet; rm -rf ~", "--dangerously-skip-permissions", "a b", "x&calc", "$(id)"]) {
      assert.match(assistantProblems(assistant({ agentId: "claude", model })).join(" "), /letters, numbers/, model);
    }
  });
});

describe("running a CLI", () => {
  const folder = mkdtempSync(join(tmpdir(), "huddle-cli-test-"));
  after(() => rmSync(folder, { recursive: true, force: true }));
  const script = (name: string, body: string) => {
    const file = join(folder, name);
    writeFileSync(file, body);
    return file;
  };
  const options = (fields: Partial<RunOptions> = {}): RunOptions => ({ stdin: "", cwd: folder, env: process.env, timeoutMs: 20_000, ...fields });

  it("hands it stdin and returns what it printed and its exit code", async () => {
    const echo = script("echo.mjs", "let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', () => { process.stdout.write(s.toUpperCase()); process.stderr.write('done'); process.exit(4); });");
    const ran = await runProgram("node", [echo], options({ stdin: "it's a \"quoted\" & <tricky> request" }));
    assert.deepEqual(ran, { code: 4, stdout: "IT'S A \"QUOTED\" & <TRICKY> REQUEST", stderr: "done" });
  });

  it("stops a CLI that runs too long, or when the run is stopped", async () => {
    const forever = script("forever.mjs", "setInterval(() => {}, 1000);");
    await assert.rejects(runProgram("node", [forever], options({ timeoutMs: 400 })), { name: "TimeoutError" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("run stopped")), 300);
    await assert.rejects(runProgram("node", [forever], options({ signal: controller.signal })), /run stopped/);
  });

  it("says a CLI that isn't installed is missing", async () => {
    await assert.rejects(runProgram("huddle-no-such-agent-cli", [], options()), { code: "ENOENT" });
  });
});
