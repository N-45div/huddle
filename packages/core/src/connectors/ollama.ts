import { type Connector, dataIn, keyFor, memoryText } from "../connector.ts";

/**
 * Ollama, on this machine or on ollama.com, through its own API (POST /api/chat), so a flow can run
 * entirely offline. The address defaults to this machine; for ollama.com give https://ollama.com and the
 * key's variable in keyEnv (OLLAMA_API_KEY). The model is the name Ollama knows it by ("qwen3",
 * "gemma3:4b"), as `ollama list` shows. Memory goes in as a system message.
 */

export const OLLAMA_URL = "http://127.0.0.1:11434";
const TIMEOUT_MS = 300_000;

/** The server's root, whether someone pasted it with /api or /v1 on the end or not. */
const rootOf = (url: string | undefined): string => (url ?? OLLAMA_URL).replace(/\/+$/, "").replace(/\/(api|v1)$/, "");

const unreachable = (root: string) => `Can't reach Ollama at ${root}. Is it running? Start the Ollama app, or run: ollama serve`;

export function ollama(fetcher: typeof fetch = globalThis.fetch): Connector {
  return {
    async send({ assistant, ask, memory, signal }) {
      if (!assistant.model) throw new Error(`Assistant "${assistant.id}" needs a model: one of the names \`ollama list\` shows, like "qwen3".`);
      const key = keyFor(assistant);
      const root = rootOf(assistant.url);
      const messages = [
        ...(memory.length ? [{ role: "system", content: `What you may use about the person:\n${memoryText(memory)}` }] : []),
        { role: "user", content: ask },
      ];
      let response: Response;
      try {
        response = await fetcher(`${root}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
          // stream defaults to true on Ollama's own API; one JSON answer is what a step needs.
          body: JSON.stringify({ model: assistant.model, messages, stream: false }),
          signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") throw new Error(`${assistant.id} (${assistant.model}) didn't answer within ${TIMEOUT_MS / 60_000} minutes.`);
        throw new Error(`${assistant.id}: ${unreachable(root)}`);
      }
      const body = (await response.json().catch(() => null)) as { message?: { content?: unknown }; error?: unknown } | null;
      if (!response.ok || body?.error) {
        const said = typeof body?.error === "string" ? body.error : `HTTP ${response.status}`;
        const hint =
          response.status === 404 && /not found/i.test(said) ? ` Pull it first: ollama pull ${assistant.model}`
          : response.status === 401 || response.status === 403 ? ` Check the key in ${assistant.keyEnv ?? "keyEnv"}.`
          : "";
        throw new Error(`${assistant.id} said: ${key ? said.replaceAll(key, "[key]") : said}.${hint}`);
      }
      const text = typeof body?.message?.content === "string" ? body.message.content.trim() : "";
      if (!text) throw new Error(`${assistant.id} (${assistant.model}) answered without any text.`);
      const data = dataIn(text);
      return data === undefined ? { text } : { text, data };
    },
  };
}

/** The models an Ollama has, by name, for picking one; ollama.com's list needs no key. */
export async function ollamaModels(url: string | undefined, fetcher: typeof fetch = globalThis.fetch): Promise<string[]> {
  const root = rootOf(url);
  let response: Response;
  try {
    response = await fetcher(`${root}/api/tags`, { signal: AbortSignal.timeout(5_000) });
  } catch {
    throw new Error(unreachable(root));
  }
  if (!response.ok) throw new Error(`Ollama at ${root} answered HTTP ${response.status}.`);
  const body = (await response.json().catch(() => null)) as { models?: { name?: unknown; model?: unknown }[] } | null;
  if (!Array.isArray(body?.models)) throw new Error(`${root} doesn't look like Ollama.`);
  const names = body.models.map((model) => (typeof model.name === "string" ? model.name : typeof model.model === "string" ? model.model : "")).filter(Boolean);
  return [...new Set(names)].sort();
}
