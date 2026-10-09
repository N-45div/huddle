import { type Connector, dataIn, keyFor, memoryText } from "../connector.ts";

/**
 * Sochen (sochen.dev) through its Agent API: POST /api/v1/run with the request, and Sochen's crew of
 * pets does the work. Needs a Pro plan's API key (sk_sochen_…), read from SOCHEN_API_KEY unless the
 * assistant names another variable. Anything Sochen would spend, send or book still waits for its
 * person's OK inside Sochen.
 */

const TIMEOUT_MS = 300_000;

export function sochen(fetcher: typeof fetch = globalThis.fetch): Connector {
  return {
    async send({ assistant, ask, memory, signal }) {
      const key = keyFor(assistant, "SOCHEN_API_KEY")!;
      const base = (assistant.url ?? "https://sochen.dev").replace(/\/$/, "");
      const message = memory.length ? `${ask}\n\nWhat you may use about me:\n${memoryText(memory)}` : ask;
      const response = await fetcher(`${base}/api/v1/run`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ message }),
        signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = (await response.json().catch(() => null)) as { status?: unknown; answer?: unknown; note?: unknown; chat_id?: unknown; error?: unknown } | null;
      if (!response.ok) {
        const reason = typeof body?.error === "string" ? body.error : `HTTP ${response.status}`;
        throw new Error(`Sochen said: ${reason.replaceAll(key, "[key]")}`);
      }
      const answer = typeof body?.answer === "string" ? body.answer : "";
      // "answered", or "needs_approval" / "working" (202) with Sochen's own note on what's next.
      const status = typeof body?.status === "string" ? body.status : "answered";
      const note = typeof body?.note === "string" ? body.note : "";
      const text = [answer, note].filter(Boolean).join("\n\n") || `Sochen is ${status.replaceAll("_", " ")}; open the chat to see it.`;
      const data = dataIn(answer);
      return { text, data: { ...(data && typeof data === "object" ? (data as object) : {}), status, chat: typeof body?.chat_id === "string" ? body.chat_id : null } };
    },
  };
}
