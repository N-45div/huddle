import { MONID_API } from "./monid.ts";
import type { Assistant, Flow } from "./schema.ts";
import type { LogLine, Note } from "./store.ts";
import { TAVILY_API } from "./tavily.ts";
import { CONTEXT_DEV_API } from "./contextdev.ts";
import { TOKEN_FACTORY_URL } from "./tokenfactory.ts";

/**
 * A run's privacy receipt: where your requests went, and which of your notes went with them. It's worked
 * out from the run's own log when it's read, so it records what happened, not what a setting promises:
 * each hand-off's assistant and where that assistant lives, how much was sent, and the notes from its
 * memory slices; and what a fact check sent to the web. Assistants that never get memory (email, search,
 * Monid, Home Assistant) are shown with none.
 */

export interface Destination {
  /** In words: "Nebius Token Factory (api.tokenfactory.nebius.com)", "Hermes Agent on this machine". */
  readonly label: string;
  /** The service's host, when the request leaves this machine for one. */
  readonly host: string | null;
  /** Whether the request stays on this machine. */
  readonly local: boolean;
}

export interface SentNote {
  readonly id: string;
  /** Null when the note has been forgotten since. */
  readonly slice: string | null;
  readonly note: string | null;
}

export interface Disclosure {
  readonly stepId: string;
  readonly assistant: string;
  readonly to: Destination;
  /** Characters of the request itself. */
  readonly chars: number;
  /** Images sent with it (photos the run started with). */
  readonly images: number;
  readonly notes: readonly SentNote[];
  readonly at: string;
}

export interface Search {
  readonly stepId: string;
  /** What was searched for (the facts a check looked up). */
  readonly queries: readonly string[];
  readonly sentTo: readonly string[];
}

export interface Receipt {
  readonly disclosures: readonly Disclosure[];
  readonly searches: readonly Search[];
  /** Every service outside this machine that saw something from this run. */
  readonly services: readonly string[];
}

/** Connectors that never send the assistant your notes. */
const NO_MEMORY = new Set<Assistant["connector"]>(["email", "tavily", "contextdev", "monid", "homeassistant", "mock"]);

const SERVICE: Partial<Record<Assistant["connector"], { readonly name: string; readonly url: string }>> = {
  openclaw: { name: "OpenClaw", url: "http://127.0.0.1:18789" },
  hermes: { name: "Hermes Agent", url: "http://127.0.0.1:9900" },
  ollama: { name: "Ollama", url: "http://127.0.0.1:11434" },
  vllm: { name: "vLLM", url: "http://127.0.0.1:8000" },
  nebius: { name: "Nebius Token Factory", url: TOKEN_FACTORY_URL },
  tavily: { name: "Tavily", url: TAVILY_API },
  contextdev: { name: "context.dev", url: CONTEXT_DEV_API },
  monid: { name: "Monid", url: MONID_API },
  email: { name: "Resend (email)", url: "https://api.resend.com" },
  sochen: { name: "Sochen", url: "https://sochen.dev" },
  instinct: { name: "open-instinct", url: "http://127.0.0.1:8080" },
};

const CLI_VENDOR: Readonly<Record<string, string>> = { claude: "Anthropic, through Claude Code", codex: "OpenAI, through Codex", opencode: "its model provider, through OpenCode" };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Where an assistant's requests go. */
export function destinationOf(assistant: Assistant): Destination {
  if (assistant.connector === "mock") return { label: "nowhere: a stand-in on this machine", host: null, local: true };
  if (assistant.connector === "openshell") return { label: `the OpenShell sandbox "${assistant.agentId ?? "?"}" on this machine (what it reaches is up to your OpenShell rules)`, host: null, local: true };
  if (assistant.connector === "cli") return { label: `${CLI_VENDOR[assistant.agentId ?? ""] ?? "an agent CLI"} on this computer`, host: null, local: false };
  const known = SERVICE[assistant.connector];
  const url = assistant.url ?? known?.url;
  let host: string | null = null;
  try {
    host = url ? new URL(url).hostname : null;
  } catch {
    host = null;
  }
  const name = known?.name ?? assistant.name ?? assistant.connector;
  if (!host) return { label: name, host: null, local: false };
  if (LOOPBACK.has(host)) return { label: `${name} on this machine`, host: null, local: true };
  return { label: `${name} (${host})`, host, local: false };
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/** The receipt for a run, from its flow, its log, and the notes as they are now. */
export function receiptOf(flow: Flow, log: readonly LogLine[], notes: readonly Note[]): Receipt {
  const byId = new Map(notes.map((note) => [note.id, note]));
  const disclosures: Disclosure[] = [];
  const searches: Search[] = [];
  for (const line of log) {
    const detail = record(line.detail);
    if (line.kind === "asked") {
      const assistant = flow.assistants.find((candidate) => candidate.id === detail.assistant);
      if (!assistant) continue;
      const sent = NO_MEMORY.has(assistant.connector) ? [] : strings(detail.memory);
      disclosures.push({
        stepId: line.stepId,
        assistant: assistant.name ?? assistant.id,
        to: destinationOf(assistant),
        chars: typeof detail.ask === "string" ? detail.ask.length : 0,
        images: typeof detail.images === "number" ? detail.images : 0,
        notes: sent.map((id) => {
          const note = byId.get(id);
          return { id, slice: note?.slice ?? null, note: note?.note ?? null };
        }),
        at: line.at,
      });
    }
    if (line.kind === "fact-checked") searches.push({ stepId: line.stepId, queries: strings(detail.claims), sentTo: strings(detail.sentTo) });
    // Learning from what you said: your words, and nothing else, went to the model that reads them.
    if (line.kind === "learned") {
      const host = typeof detail.host === "string" ? detail.host : null;
      const local = host !== null && LOOPBACK.has(host);
      disclosures.push({
        stepId: line.stepId,
        assistant: `Learning from what you said (${typeof detail.by === "string" ? detail.by : "a model"})`,
        to: { label: typeof detail.to === "string" ? detail.to : (host ?? "a model"), host: local ? null : host, local },
        chars: typeof detail.chars === "number" ? detail.chars : 0,
        images: 0,
        notes: [],
        at: line.at,
      });
    }
  }
  const services = [...new Set([...disclosures.map((disclosure) => disclosure.to.host).filter((host): host is string => Boolean(host)), ...searches.flatMap((search) => search.sentTo)])].sort();
  return { disclosures, searches, services };
}
