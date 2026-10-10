import { type Connector, dataIn, keyFor, memoryText } from "../connector.ts";
import type { Usage } from "../cost.ts";

/**
 * Assistants that answer the OpenAI chat-completions format, which many self-hosted ones serve:
 * OpenClaw (opt-in, model "openclaw/<agentId>"), Hermes Agent's API server, Open WebUI, AnythingLLM,
 * LibreChat's Agents API and Letta. POST <url>/v1/chat/completions with the memory as a system note
 * and the request as the user's message. It's a plain reply with no task to follow, so for approvals
 * inside the assistant, prefer A2A where the assistant has it.
 */

const TIMEOUT_MS = 300_000;

export function openai(fetcher: typeof fetch = globalThis.fetch): Connector {
  return {
    async send({ assistant, ask, memory, signal }) {
      if (!assistant.url) throw new Error(`Assistant "${assistant.id}" uses the openai connector but has no url.`);
      const key = keyFor(assistant);
      const url = assistant.url.endsWith("/chat/completions") ? assistant.url : `${assistant.url.replace(/\/$/, "")}/v1/chat/completions`;
      const messages = [
        ...(memory.length ? [{ role: "system", content: `What you may use about the person:\n${memoryText(memory)}` }] : []),
        { role: "user", content: ask },
      ];
      const response = await fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: assistant.model ?? "default", messages, stream: false, ...(assistant.maxTokens ? { max_tokens: assistant.maxTokens } : {}) }),
        signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = (await response.json().catch(() => null)) as {
        choices?: { message?: { content?: string | { type?: string; text?: string }[] }; finish_reason?: string }[];
        error?: { message?: string } | string;
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } };
      } | null;
      if (!response.ok) {
        const reason = typeof body?.error === "string" ? body.error : (body?.error?.message ?? `HTTP ${response.status}`);
        throw new Error(`${assistant.id} said: ${key ? reason.replaceAll(key, "[key]") : reason}`);
      }
      const content = body?.choices?.[0]?.message?.content;
      const text = typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");
      if (!text && body?.choices?.[0]?.finish_reason === "length") {
        throw new Error(`${assistant.id} ran out of tokens before it answered (its cap is ${assistant.maxTokens ?? "the API's default"}; reasoning models spend some thinking). Raise its longest answer, or leave it empty.`);
      }
      if (!text) throw new Error(`${assistant.id} answered without any text.`);
      const data = dataIn(text);
      const usage = usageOf(body?.usage);
      return { text, ...(data === undefined ? {} : { data }), ...(usage ? { usage } : {}) };
    },
  };
}

const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

/** OpenAI's usage block; OpenRouter adds what it cost. */
function usageOf(usage: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } } | undefined): Usage | undefined {
  const inputTokens = count(usage?.prompt_tokens);
  const outputTokens = count(usage?.completion_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cachedTokens = count(usage?.prompt_tokens_details?.cached_tokens);
  const costUsd = count(usage?.cost);
  return { inputTokens, outputTokens, ...(cachedTokens ? { cachedTokens } : {}), ...(costUsd !== undefined ? { costUsd } : {}) };
}
