import { createHmac, timingSafeEqual } from "node:crypto";
import { askFirst, type Caller, callerDecision, EMAIL_PATTERN, type ReceivedEmail, receivedEmail } from "@huddle/core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppOptions } from "./app.ts";

/**
 * Email in, through Resend (https://resend.com/docs/dashboard/receiving/introduction): Resend takes
 * mail for your domain and posts an email.received event to /hooks/email, one address for every flow.
 * Huddle checks the event's Svix signature (RESEND_WEBHOOK_SECRET), fetches the mail (the event only
 * names it; RESEND_API_KEY), and starts each flow whose email trigger is one of the addresses it was
 * sent to. Who sent it counts under the flow's callers rule, as over A2A: you (HUDDLE_OWNER_EMAILS),
 * one of your contacts (by their addresses), or a stranger. A From line is easy to forge, so a sender
 * only counts as you or a contact when the receiving server found the mail really came from that
 * domain (DKIM or DMARC passed). Resend retries an event until it gets a 2xx, so each event is handled
 * once.
 */

export interface EmailOptions {
  /** The signing secret of Resend's webhook (whsec_...); without it every event is turned away. */
  readonly webhookSecret?: string;
  /** For fetching the mail an event names: a full-access Resend key (a sending-only one can't read mail). */
  readonly apiKey?: string;
  /** Addresses that are you. */
  readonly ownerEmails?: readonly string[];
}

/** How far a signed event's time may be from now: what Svix's own libraries allow. */
const TOLERANCE_S = 5 * 60;
/** How long event ids are remembered: Resend's retries span a little over a day. */
const KEEP_MS = 3 * 86_400_000;
/** How long fetching the mail may take, so Resend gets its answer before it gives up on the call. */
const FETCH_MS = 10_000;
const MAX_INPUT = 100_000;

/** A Resend webhook event: what Huddle reads of it. */
interface ResendEvent {
  readonly type?: unknown;
  readonly data?: { readonly email_id?: unknown };
}

export interface SvixHeaders {
  readonly id?: string;
  readonly timestamp?: string;
  readonly signature?: string;
}

/**
 * Whether an event was signed with `secret` the Svix way: HMAC-SHA256 over "id.timestamp.body" with
 * the secret's bytes (base64, after "whsec_"), sent as space-separated "v1,<base64>" signatures, at a
 * time within 5 minutes of now. https://docs.svix.com/receiving/verifying-payloads/how-manual
 */
export function verifySvix(secret: string, headers: SvixHeaders, body: string, nowMs = Date.now()): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > TOLERANCE_S) return false;
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret, "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  return signature.split(" ").some((entry) => {
    const [version, value] = entry.split(",");
    if (version !== "v1" || !value) return false;
    const given = Buffer.from(value, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** The bare address in "Name <address>" or "address", lowercased; "" when there isn't one. */
export function addressOf(value: string): string {
  const address = (/<([^<>]*)>/.exec(value)?.[1] ?? value).trim().toLowerCase();
  return EMAIL_PATTERN.test(address) ? address : "";
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Readable text from an HTML email: blocks become lines, tags go, and common entities are decoded. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/t[dh]\s*>/gi, " ")
    .replace(/<\/tr\s*>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|blockquote|table|ul|ol)\s*>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
      if (!code.startsWith("#")) return ENTITIES[code.toLowerCase()] ?? whole;
      const point = /^#x/i.test(code) ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    });
  return text
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** One header's value (headers come keyed in any case), on one line. */
function header(headers: Readonly<Record<string, unknown>>, name: string): string {
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first.replace(/[\r\n]+/g, " ").trim() : "";
}

/** The run's input: who it's from, who it's to and the subject, then the message (text, or the HTML as text). */
export function inputOf(mail: ReceivedEmail): string {
  const from = addressOf(mail.from);
  const shown = header(mail.headers, "from");
  const body = mail.text?.trim() ? mail.text.trim() : mail.html ? htmlToText(mail.html.slice(0, 5 * MAX_INPUT)) : "";
  const subject = mail.subject.replace(/[\r\n]+/g, " ").trim();
  return `From: ${shown && addressOf(shown) === from ? shown : mail.from}\nTo: ${mail.to.join(", ")}\nSubject: ${subject}\n\n${body}`.slice(0, MAX_INPUT);
}

export function emailRoutes(options: AppOptions): Hono {
  const { store, engine } = options;
  const settings = options.email ?? {};
  const owners = new Set((settings.ownerEmails ?? []).map(addressOf).filter(Boolean));
  // The events already handled, so a retry from Resend doesn't start a second run.
  store.db.exec("CREATE TABLE IF NOT EXISTS email_events (id TEXT PRIMARY KEY, at TEXT NOT NULL)");
  const claim = (id: string): boolean => {
    store.db.prepare("DELETE FROM email_events WHERE at < ?").run(new Date(Date.now() - KEEP_MS).toISOString());
    return Number(store.db.prepare("INSERT OR IGNORE INTO email_events (id, at) VALUES (?, ?)").run(id, new Date().toISOString()).changes) === 1;
  };
  const release = (id: string) => void store.db.prepare("DELETE FROM email_events WHERE id = ?").run(id);

  /** You, a contact or a stranger, by the sender's address, counted only when the mail proves it. */
  const senderOf = (mail: ReceivedEmail): Caller => {
    const from = addressOf(mail.from);
    const proven = mail.authentication?.dkim === "pass" || mail.authentication?.dmarc === "pass";
    const contact = from ? store.contactByEmail(from) : null;
    if (proven && owners.has(from)) return { tier: "owner", name: "You", contactId: null };
    if (proven && contact) return { tier: contact.tier, name: contact.name, contactId: contact.id };
    const claimed = owners.has(from) || contact !== null;
    return { tier: "stranger", name: `${from || "Someone"} (${claimed ? "not proven to be them" : "not in your contacts"})`, contactId: null };
  };

  /** Starts each flow that answers one of the mail's addresses, under its callers rule; the runs' ids. */
  const startFlows = (mail: ReceivedEmail): string[] => {
    const recipients = new Set([...mail.to, ...mail.cc, ...mail.bcc, ...mail.receivedFor].map(addressOf).filter(Boolean));
    const flows = store.flows().filter((saved) => saved.flow.trigger.type === "email" && recipients.has(saved.flow.trigger.address.toLowerCase()));
    const said = `[huddle] email ${mail.id} from ${addressOf(mail.from) || "an unknown sender"}`;
    if (flows.length === 0) {
      console.log(`${said}: no flow answers ${[...recipients].join(", ") || "its addresses"}; ignored.`);
      return [];
    }
    const sender = senderOf(mail);
    const who = sender.tier === "owner" || sender.tier === "stranger" ? sender.name : `${sender.name} (${sender.tier})`;
    const input = inputOf(mail);
    const runIds: string[] = [];
    for (const saved of flows) {
      const decision = callerDecision(saved.flow.callers, sender.tier);
      if (decision === "refuse") {
        console.log(`${said}: "${saved.flow.name}" doesn't take mail from ${who}; dropped.`);
        continue;
      }
      const flow = decision === "ask" ? askFirst(saved.flow, who) : saved.flow;
      runIds.push(engine.launch(flow, input, saved.id, { name: sender.name, tier: sender.tier, via: "email" }));
    }
    return runIds;
  };

  const app = new Hono();
  app.post("/hooks/email", bodyLimit({ maxSize: 1_000_000, onError: (c) => c.json({ error: "That's too big for an email event." }, 413) }), async (c) => {
    const secret = settings.webhookSecret;
    if (!secret) return c.json({ error: "Email isn't set up on this Huddle: set RESEND_WEBHOOK_SECRET to the signing secret of Resend's webhook." }, 401);
    const headers: SvixHeaders = { id: c.req.header("svix-id"), timestamp: c.req.header("svix-timestamp"), signature: c.req.header("svix-signature") };
    const raw = await c.req.text();
    if (!headers.id || !verifySvix(secret, headers, raw)) return c.json({ error: "That isn't an event signed with this Huddle's Resend webhook secret, or it's too old." }, 401);
    let event: ResendEvent | null;
    try {
      event = JSON.parse(raw) as ResendEvent | null;
    } catch {
      return c.json({ error: "The event isn't JSON." }, 400);
    }
    // Sent, delivered, bounced and the rest: nothing for Huddle to do, but say OK so Resend stops.
    if (event?.type !== "email.received") return c.json({ ignored: typeof event?.type === "string" ? event.type : "unknown" });
    const emailId = event.data?.email_id;
    if (typeof emailId !== "string" || !emailId) {
      console.log("[huddle] an email.received event came without an email id; ignored.");
      return c.json({ ignored: "no email id" });
    }
    if (!settings.apiKey) {
      console.error(`[huddle] email ${emailId} arrived, but Huddle can't read it: set RESEND_API_KEY (a full-access key). Resend will send it again.`);
      return c.json({ error: "Huddle can't read the mail: RESEND_API_KEY isn't set." }, 500);
    }
    if (!claim(headers.id)) return c.json({ duplicate: true });
    let mail: ReceivedEmail;
    try {
      mail = await receivedEmail(emailId, settings.apiKey, options.fetcher, AbortSignal.timeout(FETCH_MS));
    } catch (error) {
      // Not handled after all: Resend's retry gets another go.
      release(headers.id);
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[huddle] email ${emailId}: couldn't fetch it from Resend: ${reason}`);
      return c.json({ error: `Couldn't fetch the mail from Resend: ${reason}` }, 502);
    }
    return c.json({ started: startFlows(mail) });
  });
  return app;
}
