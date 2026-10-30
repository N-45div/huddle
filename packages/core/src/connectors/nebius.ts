import type { Connector } from "../connector.ts";
import { TOKEN_FACTORY_URL } from "../tokenfactory.ts";
import { openai } from "./openai.ts";

/**
 * NVIDIA's open Nemotron models (and the others) on Nebius Token Factory, paid per token: Lightning for
 * quick everyday answers, Super VL for most work, Ultra for hard reasoning. The key is NEBIUS_API_KEY unless
 * the assistant names another variable. The model thinks before it answers only when `thinking` is on: it's
 * slower and the thinking is billed as output.
 */

export function nebius(fetcher: typeof fetch = globalThis.fetch): Connector {
  const chat = openai(fetcher, (assistant) => ({ chat_template_kwargs: { enable_thinking: assistant.thinking ?? false } }));
  return {
    async send(request) {
      const { assistant } = request;
      if (!assistant.model) throw new Error(`Assistant "${assistant.id}" needs a Token Factory model, like nvidia/Nemotron-3.5-Super-VL.`);
      return chat.send({ ...request, assistant: { ...assistant, url: assistant.url ?? TOKEN_FACTORY_URL, keyEnv: assistant.keyEnv ?? "NEBIUS_API_KEY" } });
    },
  };
}
