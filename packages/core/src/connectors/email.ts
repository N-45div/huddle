import { type Connector, keyFor } from "../connector.ts";

/**
 * Email, through Resend (https://resend.com/docs/api-reference/emails/send-email): POST /emails with
 * the step's text, to the addresses the assistant lists, from an address on a domain you verified in
 * Resend. The key comes from RESEND_API_KEY unless the assistant names another variable. A first line
 * "Subject: ..." is the subject and the rest is the message. Memory isn't sent: an email goes to
 * people, not to an assistant. Once it's sent it's gone, so put an approval step in front of it.
 *
 * Resend's receiving API is here too, for the server's email trigger: an email.received event only
 * names the mail, and `receivedEmail` fetches what it says
 * (https://resend.com/docs/api-reference/emails/retrieve-received-email).
 */

export const RESEND_API = "https://api.resend.com";
/** Resend turns away API calls that don't say who is calling. */
export const USER_AGENT = "Huddle (+https://github.com/N-45div/huddle)";
const DEFAULT_SUBJECT = "A message from Huddle";
const TIMEOUT_MS = 30_000;

/** Resend's error body. */
interface ResendError {
  readonly statusCode?: unknown;
  readonly name?: unknown;
  readonly message?: unknown;
}

/** The subject and the message: a first line "Subject: ..." is the subject, the rest the message. */
export function subjectAndBody(text: string): { readonly subject: string; readonly body: string } {
  const tidy = (part: string) => part.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();
  const match = /^\s*subject:[ \t]*([^\r\n]*)/i.exec(text);
  if (!match) return { subject: DEFAULT_SUBJECT, body: tidy(text) };
  return { subject: (match[1] ?? "").trim().slice(0, 250) || DEFAULT_SUBJECT, body: tidy(text.slice(match[0].length).replace(/^\r?\n/, "")) };
}

/** What Resend's error means, in plain words. `keyName` is the variable the key came from. */
export function resendProblem(status: number, said: ResendError | null, keyName: string, from?: string): string {
  const name = typeof said?.name === "string" ? said.name : "";
  const message = typeof said?.message === "string" && said.message ? said.message : `HTTP ${status}`;
  if (name === "restricted_api_key" && status === 401) return `The key in ${keyName} can only send email; reading received mail needs a full-access key (Resend → API Keys).`;
  if (["missing_api_key", "invalid_api_key", "restricted_api_key", "suspended_api_key"].includes(name) || ((status === 401 || status === 403) && /api key/i.test(message))) {
    return `Resend didn't take the key in ${keyName}: ${message}. Check it in Resend → API Keys.`;
  }
  if (/domain is not verified/i.test(message)) return `Resend won't send from ${from ?? "that address"}: its domain isn't verified. Verify it in Resend → Domains, or send from an address on a domain you did verify.`;
  if (/only send testing emails/i.test(message)) return `Resend only sends to your own address until you verify a domain: ${message}`;
  if (name === "daily_quota_exceeded") return "Resend's daily sending quota is used up; it resets at midnight UTC.";
  if (name === "monthly_quota_exceeded") return "Resend's monthly sending quota is used up.";
  if (status === 429) return "Resend says Huddle is calling too fast (it allows a few requests a second); try again in a moment.";
  if (status >= 500) return `Resend is having trouble (${message}); try again later.`;
  return `Resend turned it down: ${message}`;
}

/** A call to Resend's API, with its key and the User-Agent it insists on; errors are plain words. */
async function resend(fetcher: typeof fetch, path: string, init: { readonly method: string; readonly key: string; readonly keyName: string; readonly body?: unknown; readonly from?: string; readonly signal?: AbortSignal }): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(`${RESEND_API}${path}`, {
      method: init.method,
      headers: { accept: "application/json", authorization: `Bearer ${init.key}`, "user-agent": USER_AGENT, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new Error(timedOut ? "Resend didn't answer in time." : `Can't reach Resend: ${error instanceof Error ? error.message : String(error)}`);
  }
  const said = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) throw new Error(resendProblem(response.status, said, init.keyName, init.from).replaceAll(init.key, "[key]"));
  return said ?? {};
}

export function email(fetcher: typeof fetch = globalThis.fetch): Connector {
  return {
    async send({ assistant, ask, signal }) {
      const to = assistant.to ?? [];
      if (to.length === 0 || !assistant.from) throw new Error(`Assistant "${assistant.id}" sends email but doesn't say who it goes to (to) and who it's from (from).`);
      const key = keyFor(assistant, "RESEND_API_KEY")!;
      const { subject, body } = subjectAndBody(ask);
      if (!body) throw new Error(`There's nothing to send: the text for "${assistant.id}" has no message.`);
      const sent = await resend(fetcher, "/emails", { method: "POST", key, keyName: assistant.keyEnv ?? "RESEND_API_KEY", from: assistant.from, body: { from: assistant.from, to, subject, text: body }, signal });
      const id = typeof sent.id === "string" ? sent.id : null;
      return { text: `Sent to ${to.join(", ")}${id ? ` (id ${id})` : ""}.`, data: { id, to, subject } };
    },
  };
}

/** A received email, as Resend's receiving API gives it: only what Huddle reads. */
export interface ReceivedEmail {
  readonly id: string;
  /** The sender's bare address. */
  readonly from: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  /** Who it was forwarded for (from the Received headers). */
  readonly receivedFor: readonly string[];
  readonly subject: string;
  readonly text: string | null;
  readonly html: string | null;
  readonly headers: Readonly<Record<string, unknown>>;
  /** SPF, DKIM and DMARC as the receiving server saw them ("pass", "fail", "gray"...); null for old mail. */
  readonly authentication: { readonly spf: string; readonly dkim: string; readonly dmarc: string } | null;
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? [value] : []);
const stringOr = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);

/** Fetches a received email's content (an email.received event carries only who, to and subject). */
export async function receivedEmail(id: string, key: string, fetcher: typeof fetch = globalThis.fetch, signal?: AbortSignal): Promise<ReceivedEmail> {
  const got = await resend(fetcher, `/emails/receiving/${encodeURIComponent(id)}`, { method: "GET", key, keyName: "RESEND_API_KEY", signal });
  const auth = got.authentication as Record<string, unknown> | null | undefined;
  return {
    id: stringOr(got.id, id),
    from: stringOr(got.from, ""),
    to: strings(got.to),
    cc: strings(got.cc),
    bcc: strings(got.bcc),
    receivedFor: strings(got.received_for),
    subject: stringOr(got.subject, ""),
    text: typeof got.text === "string" ? got.text : null,
    html: typeof got.html === "string" ? got.html : null,
    headers: got.headers && typeof got.headers === "object" ? (got.headers as Record<string, unknown>) : {},
    authentication: auth && typeof auth === "object" ? { spf: stringOr(auth.spf, "unknown"), dkim: stringOr(auth.dkim, "unknown"), dmarc: stringOr(auth.dmarc, "unknown") } : null,
  };
}
