import { type Connector, dataIn, keyFor, memoryText } from "../connector.ts";

/**
 * Agent Zero (github.com/agent0ai/agent-zero) through its external API: POST <url>/api_message with
 * the key from Settings → External Services in the X-API-KEY header (AGENT_ZERO_API_KEY unless the
 * assistant names another variable). `agentId` picks an agent profile. It answers synchronously with
 * { context_id, response }. Agent Zero's docs say to check its current source for exact shapes, so
 * pin a version you've tried.
 */

const TIMEOUT_MS = 600_000;

export function agentzero(fetcher: typeof fetch = globalThis.fetch): Connector {
  return {
    async send({ assistant, ask, memory, signal }) {
      if (!assistant.url) throw new Error(`Assistant "${assistant.id}" uses the agentzero connector but has no url.`);
      const key = keyFor(assistant, "AGENT_ZERO_API_KEY")!;
      const message = memory.length ? `${ask}\n\nWhat you may use about me:\n${memoryText(memory)}` : ask;
      const response = await fetcher(`${assistant.url.replace(/\/$/, "")}/api_message`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key },
        body: JSON.stringify({ message, ...(assistant.agentId ? { agent_profile: assistant.agentId } : {}) }),
        signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = (await response.json().catch(() => null)) as { response?: unknown; context_id?: unknown; error?: unknown } | null;
      if (!response.ok) {
        const reason = typeof body?.error === "string" ? body.error : `HTTP ${response.status}`;
        throw new Error(`Agent Zero said: ${reason.replaceAll(key, "[key]")}`);
      }
      const text = typeof body?.response === "string" ? body.response : "";
      if (!text) throw new Error(`Agent Zero answered without a response.`);
      const data = dataIn(text);
      return { text, data: { ...(data && typeof data === "object" ? data : {}), context: typeof body?.context_id === "string" ? body.context_id : null } };
    },
  };
}
