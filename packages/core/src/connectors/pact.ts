import { randomUUID } from "node:crypto";
import { type Connector, dataIn, memoryText } from "../connector.ts";
import type { PactIdentity } from "../pact/identity.ts";

/**
 * A business's support agent over PACT 1.0 (https://github.com/openpactprotocol/openpactprotocol):
 * Huddle is the person's personal agent. It reads the business's Agent Card (`url`) for its A2A
 * HTTP+JSON interface, and sends each message with a fresh ES256 JWT it signs itself (`aud` = the
 * Provider's `audience`). Replies are synchronous. Within one run, later steps to the same business
 * continue the same conversation, so it can ask "what's the order number?" and get it next step.
 *
 * When the business needs the person to sign in (delegated authority, a task in TASK_STATE_AUTH_REQUIRED)
 * the step comes back with state "auth_required" and the sign-in link, for a flow to branch on.
 */

interface Part {
  readonly text?: unknown;
  readonly data?: unknown;
}
interface Reply {
  readonly message?: { readonly contextId?: string; readonly parts?: readonly Part[] };
  readonly task?: { readonly id?: string; readonly contextId?: string; readonly status?: { readonly state?: string; readonly message?: { readonly parts?: readonly Part[] } }; readonly metadata?: Record<string, unknown> };
  readonly error?: { readonly message?: string; readonly status?: string; readonly details?: readonly { readonly reason?: string }[] };
}

const textOf = (parts: readonly Part[] | undefined) => (parts ?? []).map((part) => (typeof part.text === "string" ? part.text : "")).filter(Boolean).join("\n");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function pact(identity: () => PactIdentity | null, fetcher: typeof fetch = globalThis.fetch): Connector {
  const cards = new Map<string, { readonly name: string; readonly interfaceUrl: string }>();
  /** One conversation per (run, assistant), so a business can ask a follow-up the next step answers. */
  const contexts = new Map<string, string>();

  async function cardOf(url: string) {
    const known = cards.get(url);
    if (known) return known;
    let response: Response;
    try {
      response = await fetcher(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new Error(`Can't reach the Agent Card at ${url}.`);
    }
    if (response.status === 404) throw new Error(`There's no agent at ${url} (404): check the Agent Card URL the business gave you.`);
    if (!response.ok) throw new Error(`The Agent Card at ${url} answered HTTP ${response.status}.`);
    const card = (await response.json().catch(() => null)) as { name?: unknown; supportedInterfaces?: { url?: unknown; protocolBinding?: unknown; protocolVersion?: unknown }[] } | null;
    const iface = card?.supportedInterfaces?.find((candidate) => candidate.protocolBinding === "HTTP+JSON" && candidate.protocolVersion === "1.0");
    if (!iface || typeof iface.url !== "string") throw new Error(`The Agent Card at ${url} has no A2A HTTP+JSON 1.0 interface, so it doesn't speak PACT.`);
    const found = { name: typeof card?.name === "string" && card.name ? card.name : url, interfaceUrl: iface.url.replace(/\/+$/, "") };
    cards.set(url, found);
    return found;
  }

  return {
    async send({ assistant, ask, memory, signal, runId }) {
      const me = identity();
      if (!me) throw new Error(`Assistant "${assistant.id}" talks PACT, but Huddle has no PACT identity here. Run it from the Huddle server.`);
      if (!assistant.url || !assistant.audience) throw new Error(`Assistant "${assistant.id}" needs the business's Agent Card URL (url) and its Provider's audience (audience).`);
      const card = await cardOf(assistant.url);
      const key = `${runId ?? "none"}:${assistant.id}`;
      const text = memory.length ? `${ask}\n\nWhat you may use about me:\n${memoryText(memory)}` : ask;

      const post = async (contextId: string | undefined): Promise<{ response: Response; body: Reply | null }> => {
        for (let attempt = 0; ; attempt += 1) {
          let response: Response;
          try {
            response = await fetcher(`${card.interfaceUrl}/message:send`, {
              method: "POST",
              headers: { authorization: `Bearer ${me.sign({ aud: assistant.audience! })}`, "a2a-version": "1.0", "content-type": "application/json" },
              body: JSON.stringify({ message: { messageId: randomUUID(), role: "ROLE_USER", parts: [{ text, mediaType: "text/plain" }], ...(contextId ? { contextId } : {}) } }),
              signal: signal ?? AbortSignal.timeout(300_000),
            });
          } catch {
            throw new Error(`Can't reach ${card.name}'s agent at ${card.interfaceUrl}.`);
          }
          if (response.status === 429 && attempt < 3) {
            const header = response.headers.get("retry-after");
            const seconds = header !== null && Number.isFinite(Number(header)) ? Number(header) : 2 ** (attempt + 1);
            const wait = Math.min(60, Math.max(0, seconds)) * 1000;
            await sleep(wait);
            continue;
          }
          return { response, body: (await response.json().catch(() => null)) as Reply | null };
        }
      };

      let contextId = runId ? contexts.get(key) : undefined;
      let { response, body } = await post(contextId);
      // A conversation the business closed: start a new one, once.
      if (contextId && body?.error?.details?.[0]?.reason === "UNSUPPORTED_OPERATION") {
        contexts.delete(key);
        contextId = undefined;
        ({ response, body } = await post(undefined));
      }
      if (response.status === 401) {
        throw new Error(`${card.name} turned down Huddle's identity (401). Register Huddle with its Provider (issuer ${me.issuer}, keys at ${me.jwksUri}) and check the audience.`);
      }
      if (body?.error) {
        const reason = body.error.details?.[0]?.reason ?? body.error.status ?? `HTTP ${response.status}`;
        throw new Error(`${card.name} said: ${body.error.message ?? reason} (${reason}).`);
      }
      if (!response.ok) throw new Error(`${card.name}'s agent answered HTTP ${response.status}.`);

      if (body?.message) {
        if (runId && body.message.contextId) {
          contexts.set(key, body.message.contextId);
          if (contexts.size > 2_000) contexts.delete(contexts.keys().next().value!);
        }
        const reply = textOf(body.message.parts);
        if (!reply) throw new Error(`${card.name} answered without any text.`);
        const data = dataIn(reply);
        return { text: reply, data: { ...(data && typeof data === "object" && !Array.isArray(data) ? data : {}), state: "completed", business: card.name, context: body.message.contextId ?? null } };
      }

      const task = body?.task;
      const state = String(task?.status?.state ?? "").replace(/^TASK_STATE_/, "").toLowerCase();
      if (task && state === "auth_required") {
        const signIn = task.metadata?.["pact.verificationUriComplete"];
        const scopes = task.metadata?.["pact.missingScopes"];
        const said = textOf(task.status?.message?.parts);
        return {
          text: `${said || `${card.name} needs you to sign in before it can go on.`}${typeof signIn === "string" ? ` Sign in here: ${signIn}` : ""}`,
          data: { state: "auth_required", business: card.name, signIn: typeof signIn === "string" ? signIn : null, missingScopes: Array.isArray(scopes) ? scopes : [], task: task.id ?? null },
        };
      }
      throw new Error(`${card.name} answered with something Huddle doesn't understand${state ? ` (a task in state ${state})` : ""}.`);
    },
  };
}
