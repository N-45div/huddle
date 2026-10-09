import { randomUUID } from "node:crypto";
import { type Connector, dataIn, memoryText } from "../connector.ts";
import type { Assistant } from "../schema.ts";

/**
 * Any agent that speaks A2A (Agent2Agent, https://a2a-protocol.org, spec 1.0): Huddle reads its
 * Agent Card (/.well-known/agent-card.json) for the JSON-RPC endpoint, sends the request with
 * SendMessage, and polls GetTask until the task finishes or asks for something. OpenClaw and Hermes
 * Agent both serve A2A, so they're presets: `"connector": "openclaw"` or `"hermes"` with their usual
 * local address and token variable filled in.
 *
 * What comes back: the reply's text (from the task's artifacts, else its status message), any data
 * part as data, and the task's state. A task that needs input or auth comes back with that state so a
 * flow can branch on it ({{step.data.state}} == input_required); a failed or rejected one is an error.
 */

interface Part {
  readonly text?: string;
  readonly data?: unknown;
}
interface Task {
  readonly id: string;
  readonly contextId?: string;
  readonly status?: { readonly state?: string; readonly message?: { readonly parts?: readonly Part[] } };
  readonly artifacts?: readonly { readonly parts?: readonly Part[] }[];
}

/** The presets: where each one usually listens, and the variable its token is read from (optional). */
const PRESETS: Readonly<Record<string, { readonly url: string; readonly keyEnv: string }>> = {
  openclaw: { url: "http://127.0.0.1:18789", keyEnv: "OPENCLAW_A2A_TOKEN" },
  hermes: { url: "http://127.0.0.1:9900", keyEnv: "HERMES_A2A_TOKEN" },
};

const DONE = new Set(["completed"]);
const FAILED = new Set(["failed", "rejected", "canceled", "cancelled"]);
const NEEDS = new Set(["input_required", "auth_required"]);

/** "TASK_STATE_INPUT_REQUIRED" (1.0) and "input-required" (0.3) both read as "input_required". */
const stateOf = (task: Task): string => (task.status?.state ?? "unknown").replace(/^TASK_STATE_/i, "").replaceAll("-", "_").toLowerCase();

const textOf = (parts: readonly Part[] | undefined): string => (parts ?? []).map((part) => part.text ?? "").filter(Boolean).join("\n");

export interface A2AOptions {
  readonly pollMs?: number;
  /** How long to wait for a task to finish before giving up (default 10 minutes). */
  readonly timeoutMs?: number;
}

export function a2a(fetcher: typeof fetch = globalThis.fetch, options: A2AOptions = {}): Connector {
  const pollMs = options.pollMs ?? 2_000;
  const timeoutMs = options.timeoutMs ?? 600_000;
  const endpoints = new Map<string, string>();

  /** The JSON-RPC endpoint from the agent's card, or its url itself when it has no card. */
  async function endpointOf(base: string, headers: Record<string, string>): Promise<string> {
    const known = endpoints.get(base);
    if (known) return known;
    const cardUrl = base.endsWith(".json") ? base : `${base.replace(/\/$/, "")}/.well-known/agent-card.json`;
    let endpoint = base;
    try {
      const response = await fetcher(cardUrl, { headers, signal: AbortSignal.timeout(15_000) });
      if (response.ok) {
        const card = (await response.json()) as { supportedInterfaces?: { url?: string; protocolBinding?: string }[]; url?: string };
        endpoint = card.supportedInterfaces?.find((item) => item.protocolBinding?.toUpperCase() === "JSONRPC")?.url ?? card.url ?? base;
      }
    } catch {
      // No card: the url is the endpoint (Hermes answers JSON-RPC at its root).
    }
    endpoints.set(base, endpoint);
    return endpoint;
  }

  return {
    async send({ assistant, ask, memory, signal }) {
      const preset = PRESETS[assistant.connector];
      const base = assistant.url ?? preset?.url;
      if (!base) throw new Error(`Assistant "${assistant.id}" uses the a2a connector but has no url.`);
      const key = tokenFor(assistant, preset?.keyEnv);
      const headers: Record<string, string> = { "content-type": "application/json", "a2a-version": "1.0", ...(key ? { authorization: `Bearer ${key}` } : {}) };
      const endpoint = await endpointOf(base, headers);
      const deadline = Date.now() + timeoutMs;

      const call = async (method: string, params: unknown): Promise<unknown> => {
        const response = await fetcher(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
          signal: signal ?? AbortSignal.timeout(Math.max(1_000, deadline - Date.now())),
        });
        const body = (await response.json().catch(() => null)) as { result?: unknown; error?: { message?: string; code?: number } } | null;
        const problem = body?.error ? `${body.error.message ?? "error"} (${body.error.code ?? "?"})` : response.ok ? null : `HTTP ${response.status}`;
        if (problem) throw new Error(`${assistant.id} said: ${key ? problem.replaceAll(key, "[key]") : problem}`);
        return body?.result;
      };

      const text = memory.length ? `${ask}\n\nWhat you may use about me:\n${memoryText(memory)}` : ask;
      const sent = (await call("SendMessage", { message: { messageId: randomUUID(), role: "ROLE_USER", parts: [{ text }] } })) as { task?: Task; message?: { parts?: Part[] } } | null;
      // An agent may answer straight away with a message instead of a task.
      if (sent?.message) {
        const reply = textOf(sent.message.parts);
        return { text: reply, data: { state: "completed", ...asObject(dataPart(sent.message.parts) ?? dataIn(reply)) } };
      }
      let task = sent?.task;
      if (!task?.id) throw new Error(`${assistant.id} answered without a task or a message.`);
      while (!DONE.has(stateOf(task)) && !FAILED.has(stateOf(task)) && !NEEDS.has(stateOf(task))) {
        if (Date.now() > deadline) throw new Error(`${assistant.id} was still working after ${Math.round(timeoutMs / 60_000)} minutes (task ${task.id}).`);
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        const polled = (await call("GetTask", { id: task.id })) as Task | { task?: Task } | null;
        task = (polled && "task" in polled && polled.task ? polled.task : (polled as Task | null)) ?? task;
      }
      const state = stateOf(task);
      const said = textOf(task.status?.message?.parts);
      if (FAILED.has(state)) throw new Error(`${assistant.id}'s task ${state}${said ? `: ${said}` : "."}`);
      const parts = (task.artifacts ?? []).flatMap((artifact) => artifact.parts ?? []);
      const reply = textOf(parts) || said || (NEEDS.has(state) ? `${assistant.id} needs ${state === "auth_required" ? "you to sign in" : "more from you"} before it can go on.` : "");
      return { text: reply, data: { ...asObject(dataPart(parts) ?? dataIn(reply)), state, task: task.id, context: task.contextId ?? null } };
    },
  };
}

function dataPart(parts: readonly Part[] | undefined): unknown {
  return (parts ?? []).find((part) => part.data !== undefined)?.data;
}

function asObject(value: unknown): object {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : value === undefined ? {} : { value };
}

/** The token from the assistant's keyEnv (which must then be set), else the preset's variable if it happens to be set. */
function tokenFor(assistant: Assistant, presetEnv: string | undefined): string | undefined {
  if (assistant.keyEnv) {
    const key = process.env[assistant.keyEnv]?.trim();
    if (!key) throw new Error(`Assistant "${assistant.id}" needs its token in the ${assistant.keyEnv} environment variable.`);
    return key;
  }
  return presetEnv ? process.env[presetEnv]?.trim() || undefined : undefined;
}
