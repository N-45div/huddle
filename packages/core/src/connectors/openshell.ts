import { type Connector, dataIn, memoryText } from "../connector.ts";
import { OpenShell } from "../openshell/client.ts";

/**
 * An agent running inside an NVIDIA OpenShell sandbox: Hermes, OpenCode, Claude Code, Codex or anything
 * else with a one-shot command. OpenShell's policy decides what the agent may reach and keeps its
 * model keys out of the sandbox; Huddle hands it the request. The assistant names the sandbox
 * (agentId) and the command (e.g. ["hermes", "chat", "--query-file", "/dev/stdin", "--oneshot", "-Q"]);
 * the request, with the memory the assistant may see, goes in on stdin, or in place of "{{ask}}".
 *
 * When the agent reaches for something its policy doesn't allow, OpenShell blocks it and drafts a
 * rule; Huddle shows those in its approvals inbox, so the person can let it through.
 */

const TIMEOUT_MS = 600_000;

/** The last few lines of a program's error output, for an error message. */
const tail = (text: string) => text.trim().split("\n").slice(-6).join("\n").slice(-800);

export function openshell(gateway: () => OpenShell | null = () => OpenShell.fromEnv()): Connector {
  let shell: OpenShell | null | undefined;
  return {
    async send({ assistant, ask, memory, signal }) {
      shell ??= gateway();
      if (!shell) throw new Error(`Assistant "${assistant.id}" runs in OpenShell, but Huddle isn't connected to an OpenShell gateway. Set HUDDLE_OPENSHELL_GATEWAY (e.g. https://127.0.0.1:8080).`);
      const sandbox = assistant.agentId;
      const command = assistant.command;
      if (!sandbox || !command) throw new Error(`Assistant "${assistant.id}" needs its sandbox's name (agentId) and the command that runs its agent.`);
      const text = memory.length ? `${ask}\n\nWhat you may use about me:\n${memoryText(memory)}` : ask;
      const inline = command.some((part) => part.includes("{{ask}}"));
      const result = await shell.exec(sandbox, inline ? command.map((part) => part.replaceAll("{{ask}}", text)) : command, { stdin: inline ? "" : text, timeoutMs: TIMEOUT_MS, signal });
      if (result.exitCode !== 0) {
        const said = tail(result.stderr) || tail(result.stdout);
        throw new Error(`${assistant.id} (in sandbox ${sandbox}) stopped with exit code ${result.exitCode ?? "unknown"}${said ? `: ${said}` : "."}`);
      }
      const reply = result.stdout.trim();
      if (!reply) throw new Error(`${assistant.id} (in sandbox ${sandbox}) finished without an answer.`);
      const data = dataIn(reply);
      return data === undefined ? { text: reply } : { text: reply, data };
    },
  };
}
