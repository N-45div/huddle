import type { Connector } from "../connector.ts";
import { openai } from "./openai.ts";

/**
 * Your own model served by vLLM (`vllm serve <model>`): on this machine by default, or a GPU box or cloud
 * endpoint at its address. vLLM speaks the OpenAI chat API, so this is the OpenAI-style connector with vLLM's
 * usual address and its list of models. If you started it with --api-key, give that key's variable in keyEnv.
 */

export const VLLM_URL = "http://127.0.0.1:8000";

/** The server's root, whether it was typed with /v1 on the end or not. */
const rootOf = (url: string | undefined): string => (url ?? VLLM_URL).replace(/\/+$/, "").replace(/\/v1$/, "");

export function vllm(fetcher: typeof fetch = globalThis.fetch): Connector {
  const chat = openai(fetcher);
  return {
    async send(request) {
      if (!request.assistant.model) throw new Error(`Assistant "${request.assistant.id}" needs the model vLLM serves: its name in ${rootOf(request.assistant.url)}/v1/models.`);
      try {
        return await chat.send({ ...request, assistant: { ...request.assistant, url: rootOf(request.assistant.url) } });
      } catch (error) {
        if (error instanceof TypeError || (error instanceof Error && /fetch failed|ECONNREFUSED/.test(error.message))) {
          throw new Error(`${request.assistant.id}: can't reach vLLM at ${rootOf(request.assistant.url)}. Is it running? Start it with: vllm serve ${request.assistant.model}`);
        }
        throw error;
      }
    },
  };
}

/** The models a vLLM server has, by the names its chat API takes. */
export async function vllmModels(url: string | undefined, key?: string, fetcher: typeof fetch = globalThis.fetch): Promise<string[]> {
  const root = rootOf(url);
  let response: Response;
  try {
    response = await fetcher(`${root}/v1/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(5_000) });
  } catch {
    throw new Error(`Can't reach vLLM at ${root}. Is it running? Start it with: vllm serve <model>`);
  }
  if (response.status === 401) throw new Error(`vLLM at ${root} wants a key: give the variable that holds the one it was started with (--api-key).`);
  if (!response.ok) throw new Error(`vLLM at ${root} answered HTTP ${response.status}.`);
  const body = (await response.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
  if (!Array.isArray(body?.data)) throw new Error(`${root} doesn't look like vLLM (no model list at /v1/models).`);
  return [...new Set(body.data.map((model) => (typeof model.id === "string" ? model.id : "")).filter(Boolean))].sort();
}
