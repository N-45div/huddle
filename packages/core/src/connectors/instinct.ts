import { randomUUID } from "node:crypto";
import { type Connector, dataIn, keyFor, memoryText } from "../connector.ts";

/**
 * An open-instinct agent (github.com/mariagorskikh/open-instinct), the personal agent you text, through
 * its owner chat: POST <url>/chat with { message, source, conversation_id }. Huddle speaks to it as its
 * owner. It listens on 127.0.0.1:8080 unless its PORT says otherwise. When it sets INSTINCT_CHAT_TOKEN,
 * Huddle sends the same variable's value (or the one keyEnv names) as a Bearer token.
 *
 * Each run has a conversation of its own with each of these assistants, so later steps carry on from
 * earlier ones. Its /chat waits about 20 seconds (INSTINCT_REPLY_BUDGET_MS) and then says "On it…"
 * while it keeps working: that step comes back with state "working", and the finished answer arrives
 * with the next step that asks it, at the start of its text or, from the agent's outbox, in data.pending.
 */

const INSTINCT_URL = "http://127.0.0.1:8080";
const TIMEOUT_MS = 300_000;

/** What open-instinct's /chat says when the answer isn't ready yet (its runtime's chat ack, and its server's). */
const STILL_WORKING = new Set([
  "On it. This is taking a moment; send another message in a bit and I will have the answer here.",
  "On it. I will send the result when it is done.",
]);
/** A message starting with this is a relayed Inkbox event to open-instinct, not its owner talking. */
const EVENT_PREFIX = "@@instinct-event@@";

/** The agent's root, whether someone pasted it with /chat on the end or not. */
const rootOf = (url: string | undefined): string => (url ?? INSTINCT_URL).replace(/\/+$/, "").replace(/\/chat$/, "");

interface Reply {
  readonly response?: unknown;
  readonly blocked?: unknown;
  readonly pending?: unknown;
  readonly error?: unknown;
}

export function instinct(fetcher: typeof fetch = globalThis.fetch): Connector {
  return {
    async send({ assistant, ask, memory, signal, runId }) {
      // keyEnv must then be set; without it, INSTINCT_CHAT_TOKEN if it's set here (an agent on loopback may have none).
      const key = assistant.keyEnv ? keyFor(assistant) : process.env.INSTINCT_CHAT_TOKEN?.trim() || undefined;
      const root = rootOf(assistant.url);
      const message = memory.length ? `${ask}\n\nWhat you may use about me:\n${memoryText(memory)}` : ask;
      if (message.trimStart().startsWith(EVENT_PREFIX)) throw new Error(`${assistant.id}: the request starts with ${EVENT_PREFIX}, which open-instinct would take for a relayed event rather than you talking, so Huddle won't send it.`);
      // One conversation per (run, assistant); never "default", which is the owner's own chat.
      const conversation = `huddle-${runId ?? randomUUID()}-${assistant.id}`;
      let response: Response;
      try {
        response = await fetcher(`${root}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify({ message, source: "huddle", conversation_id: conversation }),
          signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") throw new Error(`${assistant.id} didn't answer within ${TIMEOUT_MS / 60_000} minutes.`);
        throw new Error(`${assistant.id}: Can't reach open-instinct at ${root}. Is it running? Start it in its folder with: pnpm instinct dev`);
      }
      if (response.status === 401) {
        throw new Error(
          key
            ? `${assistant.id} turned down the token (401): ${assistant.keyEnv ?? "INSTINCT_CHAT_TOKEN"} here doesn't match the agent's INSTINCT_CHAT_TOKEN.`
            : `${assistant.id} wants a token (401): set INSTINCT_CHAT_TOKEN where Huddle runs to the agent's INSTINCT_CHAT_TOKEN, or name another variable in keyEnv.`,
        );
      }
      const body = (await response.json().catch(() => null)) as Reply | null;
      if (!response.ok) {
        const reason = typeof body?.error === "string" ? body.error : `HTTP ${response.status}`;
        const hint = response.status === 404 ? ` Is ${root} an open-instinct agent?` : "";
        throw new Error(`${assistant.id} said: ${key ? reason.replaceAll(key, "[key]") : reason}.${hint}`);
      }
      if (body === null || typeof body !== "object") throw new Error(`${assistant.id} answered with something that isn't JSON. Is ${root} an open-instinct agent? It listens on ${INSTINCT_URL} unless its PORT says otherwise.`);
      if (typeof body.blocked === "string") throw new Error(`${assistant.id} didn't take it (${body.blocked}).`);
      const text = typeof body.response === "string" ? body.response.trim() : "";
      if (!text) throw new Error(`${assistant.id} answered without any text.`);
      // Answers it finished after an earlier step on this conversation got "On it".
      const pending = Array.isArray(body.pending) ? body.pending.filter((late): late is string => typeof late === "string" && late.length > 0) : [];
      const data = dataIn(text);
      return {
        text,
        data: {
          ...(data && typeof data === "object" && !Array.isArray(data) ? data : {}),
          state: STILL_WORKING.has(text) ? "working" : "completed",
          conversation,
          ...(pending.length ? { pending } : {}),
        },
      };
    },
  };
}
