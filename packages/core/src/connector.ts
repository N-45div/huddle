import type { Assistant } from "./schema.ts";
import type { Note } from "./store.ts";
import type { StepAnswer } from "./template.ts";

/**
 * How Huddle reaches an assistant. Every connector does one thing: send a request, with the memory
 * the assistant may see, and return its answer as text, plus structured data when there is some.
 */
export interface ConnectorRequest {
  readonly assistant: Assistant;
  readonly ask: string;
  /** Kept notes from the slices this assistant may read; nothing else. */
  readonly memory: readonly Note[];
  readonly signal?: AbortSignal;
  /** The run this request belongs to, so a connector can keep one conversation going across its steps. */
  readonly runId?: string;
}

export interface Connector {
  send(request: ConnectorRequest): Promise<StepAnswer>;
}

/** Structured data inside an answer: the whole answer if it's JSON, else the first ```json block. */
export function dataIn(text: string): unknown {
  const tryParse = (raw: string): unknown => {
    try {
      const value: unknown = JSON.parse(raw);
      return value !== null && typeof value === "object" ? value : undefined;
    } catch {
      return undefined;
    }
  };
  const whole = tryParse(text.trim());
  if (whole !== undefined) return whole;
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(text);
  return fenced?.[1] ? tryParse(fenced[1]) : undefined;
}

/** The key an assistant names in keyEnv, read from the environment; an error says which variable is missing. */
export function keyFor(assistant: Assistant, fallbackEnv?: string): string | undefined {
  const name = assistant.keyEnv ?? fallbackEnv;
  if (!name) return undefined;
  const key = process.env[name]?.trim();
  if (!key) throw new Error(`Assistant "${assistant.id}" needs its key in the ${name} environment variable.`);
  return key;
}

/** The notes as a few lines an assistant can read. */
export function memoryText(memory: readonly Note[]): string {
  return memory.map((note) => `- (${note.slice}) ${note.note}`).join("\n");
}
