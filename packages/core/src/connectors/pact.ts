import { randomUUID } from "node:crypto";
import { type Connector, dataIn, memoryText } from "../connector.ts";
import { checkReceipt, type DelegationScheme, DeviceCode, delegationScheme, type Grant, OAuthError, type Scope } from "../pact/delegation.ts";
import type { PactIdentity } from "../pact/identity.ts";
import type { GrantStore, SignIns } from "../pact/signins.ts";

/**
 * A business's support agent over PACT 1.0 (https://github.com/openpactprotocol/openpactprotocol):
 * Huddle is the person's personal agent. It reads the business's Agent Card (`url`) for its A2A
 * HTTP+JSON interface, and sends each message with a fresh ES256 JWT it signs itself (`aud` = the
 * Provider's `audience`). Replies are synchronous. Within one run, later steps to the same business
 * continue the same conversation, so it can ask "what's the order number?" and get it next step.
 *
 * Delegated authority (§5), when the server sets it up: an assistant's `scopes`, or the business asking
 * for more mid-conversation (step-up), start a sign-in on the business's own login page. It waits in
 * Approvals while the step keeps running; once the person approves, the token goes with every message
 * and each reply's signed receipt is checked and kept with the answer. Without it set up, a step that
 * needs a sign-in comes back with state "auth_required" and the link, for a flow to branch on.
 */

interface Part {
  readonly text?: unknown;
  readonly data?: unknown;
}
interface Reply {
  readonly message?: { readonly contextId?: string; readonly parts?: readonly Part[]; readonly metadata?: Record<string, unknown> };
  readonly task?: { readonly id?: string; readonly contextId?: string; readonly status?: { readonly state?: string; readonly message?: { readonly parts?: readonly Part[] } }; readonly metadata?: Record<string, unknown> };
  readonly error?: { readonly message?: string; readonly status?: string; readonly details?: readonly { readonly reason?: string }[] };
}

/** Where sign-ins wait for the person, and where the tokens they produce are kept. */
export interface PactDelegation {
  readonly signIns: SignIns;
  readonly grants: GrantStore;
}

const textOf = (parts: readonly Part[] | undefined) => (parts ?? []).map((part) => (typeof part.text === "string" ? part.text : "")).filter(Boolean).join("\n");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function pact(identity: () => PactIdentity | null, fetcher: typeof fetch = globalThis.fetch, delegation?: PactDelegation): Connector {
  const cards = new Map<string, { readonly name: string; readonly interfaceUrl: string; readonly scheme: DelegationScheme | null }>();
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
    const found = { name: typeof card?.name === "string" && card.name ? card.name : url, interfaceUrl: iface.url.replace(/\/+$/, ""), scheme: delegationScheme(card) };
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
      const sign = () => me.sign({ aud: assistant.audience! });

      // Delegated authority: only when the business offers it and this Huddle can show sign-ins.
      const device = card.scheme && delegation ? new DeviceCode({ scheme: card.scheme, clientId: me.issuer, sign, fetcher }) : null;
      const described = (ids: readonly string[]): Scope[] => ids.map((id) => card.scheme?.scopes.find((scope) => scope.id === id) ?? { id, description: id });

      /** A token covering `scopes`: the kept one (refreshed if it ran out), else a new sign-in the person finishes on the business's site. */
      const grantFor = async (scopes: readonly string[], fresh = false): Promise<Grant | null> => {
        if (!device || !delegation || scopes.length === 0) return null;
        let kept = fresh ? null : delegation.grants.get(card.interfaceUrl);
        if (kept && kept.expiresAt - 60_000 < Date.now()) {
          kept = kept.refreshToken ? await device.refresh(kept.refreshToken).catch(() => null) : null;
          if (kept) delegation.grants.set(card.interfaceUrl, kept);
          else delegation.grants.drop(card.interfaceUrl);
        }
        if (kept && scopes.every((scope) => kept.scopes.includes(scope))) return kept;
        const asking = [...new Set([...(kept?.scopes ?? []), ...scopes])];
        const authorization = await device.start(asking);
        try {
          const grant = await delegation.signIns.wait({ business: card.name, assistant: assistant.id, runId: runId ?? null, scopes: described(asking) }, authorization, (code) => device.poll(code), signal);
          delegation.grants.set(card.interfaceUrl, grant);
          return grant;
        } catch (error) {
          if (error instanceof OAuthError && error.code === "access_denied") throw new Error(`You said no on ${card.name}'s page, so it won't act for you.`);
          if (error instanceof OAuthError && error.code === "expired_token") throw new Error(`Signing in to ${card.name} expired before it was finished. Run the flow again to get a new link.`);
          throw error;
        }
      };
      let grant = await grantFor(assistant.scopes ?? []);

      const post = async (contextId: string | undefined): Promise<{ response: Response; body: Reply | null }> => {
        for (let attempt = 0; ; attempt += 1) {
          let response: Response;
          try {
            response = await fetcher(`${card.interfaceUrl}/message:send`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${sign()}`,
                ...(grant ? { "x-a2a-user-delegation": `Bearer ${grant.accessToken}` } : {}),
                "a2a-version": "1.0",
                "content-type": "application/json",
              },
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
      // Rounds: a step-up or a refused token gets a sign-in and one more try each, then it stops.
      for (let round = 0; ; round += 1) {
        let { response, body } = await post(contextId);
        // A conversation the business closed: start a new one, once.
        if (contextId && body?.error?.details?.[0]?.reason === "UNSUPPORTED_OPERATION") {
          contexts.delete(key);
          contextId = undefined;
          ({ response, body } = await post(undefined));
        }
        // The business turned the delegation token down (revoked, or its keys changed): sign in again.
        if (response.status === 401 && grant && /invalid_token/.test(response.headers.get("www-authenticate") ?? "") && round < 2) {
          delegation?.grants.drop(card.interfaceUrl);
          grant = await grantFor(grant.scopes, true);
          continue;
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
          const receipt = body.message.metadata?.["pact.receipt"];
          const checked = receipt !== undefined && card.scheme ? await checkReceipt(receipt, card.scheme.metadataUrl, fetcher) : null;
          return {
            text: reply,
            data: {
              ...(data && typeof data === "object" && !Array.isArray(data) ? data : {}),
              state: "completed",
              business: card.name,
              context: body.message.contextId ?? null,
              ...(checked ? { receipt: { verified: checked.verified, ...(checked.problem ? { problem: checked.problem } : {}), ...checked.claims } } : {}),
            },
          };
        }

        const task = body?.task;
        const state = String(task?.status?.state ?? "").replace(/^TASK_STATE_/, "").toLowerCase();
        if (task && state === "auth_required") {
          const signIn = task.metadata?.["pact.verificationUriComplete"];
          const scopes = task.metadata?.["pact.missingScopes"];
          const missing = Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === "string") : [];
          // Step-up (§5.5): ask the person for just what's missing, then go on in the same conversation.
          if (device && missing.length && round < 2) {
            if (task.contextId) {
              contextId = task.contextId;
              if (runId) contexts.set(key, task.contextId);
            }
            grant = await grantFor([...(grant?.scopes ?? []), ...missing]);
            continue;
          }
          const said = textOf(task.status?.message?.parts);
          return {
            text: `${said || `${card.name} needs you to sign in before it can go on.`}${typeof signIn === "string" ? ` Sign in here: ${signIn}` : ""}`,
            data: { state: "auth_required", business: card.name, signIn: typeof signIn === "string" ? signIn : null, missingScopes: missing, task: task.id ?? null },
          };
        }
        throw new Error(`${card.name} answered with something Huddle doesn't understand${state ? ` (a task in state ${state})` : ""}.`);
      }
    },
  };
}
