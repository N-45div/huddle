import { type Connector, keyFor } from "../connector.ts";

/**
 * Home Assistant's Assist, through its conversation API: POST /api/conversation/process with a
 * long-lived access token (HASS_TOKEN unless the assistant names another variable). `agentId` picks
 * one of its conversation agents. Memory isn't sent: Assist's built-in intent engine expects a plain
 * command ("turn off the kitchen lights"), and extra text would stop it matching.
 * https://developers.home-assistant.io/docs/intent_conversation_api/
 */

const TIMEOUT_MS = 60_000;

interface Reply {
  readonly conversation_id?: string;
  readonly response?: {
    readonly response_type?: string;
    readonly speech?: { readonly plain?: { readonly speech?: string } };
    readonly data?: unknown;
  };
}

export function homeassistant(fetcher: typeof fetch = globalThis.fetch): Connector {
  return {
    async send({ assistant, ask, signal }) {
      const key = keyFor(assistant, "HASS_TOKEN")!;
      const base = (assistant.url ?? "http://homeassistant.local:8123").replace(/\/$/, "");
      const response = await fetcher(`${base}/api/conversation/process`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ text: ask, ...(assistant.agentId ? { agent_id: assistant.agentId } : {}) }),
        signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Home Assistant said: HTTP ${response.status}${response.status === 401 ? " (check the access token)" : ""}`);
      const body = (await response.json().catch(() => null)) as Reply | null;
      const type = body?.response?.response_type ?? "unknown";
      const speech = body?.response?.speech?.plain?.speech ?? "";
      // "Sorry, I couldn't understand that" comes back as an error-type answer: a flow should stop on it, not carry on.
      if (type === "error") throw new Error(`Home Assistant couldn't do it${speech ? `: ${speech}` : "."}`);
      return { text: speech || (type === "action_done" ? "Done." : ""), data: { type, conversation: body?.conversation_id ?? null, result: body?.response?.data ?? null } };
    },
  };
}
