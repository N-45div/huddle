import { type Connector, dataIn, keyFor } from "../connector.ts";

/**
 * Any assistant with a simple request/response API: POST `url` with { ask, memory }, and it answers
 * { text, data? }. A key, when the assistant names one in keyEnv, goes as a Bearer token. Errors
 * never repeat the key.
 */

const TIMEOUT_MS = 120_000;

export function http(fetcher: typeof fetch = globalThis.fetch): Connector {
  return {
    async send({ assistant, ask, memory, signal }) {
      if (!assistant.url) throw new Error(`Assistant "${assistant.id}" uses the http connector but has no url.`);
      const key = keyFor(assistant);
      const response = await fetcher(assistant.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ ask, memory: memory.map((note) => ({ slice: note.slice, note: note.note })) }),
        signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = (await response.json().catch(() => null)) as { text?: unknown; data?: unknown; error?: unknown } | null;
      if (!response.ok) {
        const reason = typeof body?.error === "string" ? body.error : `HTTP ${response.status}`;
        throw new Error(`${assistant.id} said: ${key ? reason.replaceAll(key, "[key]") : reason}`);
      }
      if (typeof body?.text !== "string") throw new Error(`${assistant.id} answered without a "text" field.`);
      const data = body.data ?? dataIn(body.text);
      return data === undefined ? { text: body.text } : { text: body.text, data };
    },
  };
}
