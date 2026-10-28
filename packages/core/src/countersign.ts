import { createHash, createPublicKey, type KeyObject, randomBytes, verify } from "node:crypto";
import { cents, decimal } from "./paypal.ts";

/**
 * Countersign: what your board signs before an agent's purchase can be paid for. The board (the Huddle button,
 * or the canvas's virtual one) never goes online. It's shown the exact text below, shows the facts in it on its
 * own screen (the shop, each item, the total), and signs that text with a P-256 key that never leaves it once
 * you hold the button. The shop charges your saved PayPal only for a cart signed by the key you linked there, so
 * an agent that's tricked, or a Huddle that's been broken into, can make a cart but can't pay for one.
 *
 * The text is JSON with its keys in one fixed order and nothing extra, so there's one way to write any payment:
 * a text that isn't written exactly that way is refused, by Huddle, the shop and the board alike, and two of
 * them can't read one text two ways.
 */

/** One line of a cart, priced by the shop: `price` is for one, in the cart's currency ("12.00"). */
export interface PaymentItem {
  readonly name: string;
  readonly qty: number;
  readonly price: string;
}

/** Who's being paid: the shop's own id (its web address's host, so a lookalike name still shows as new) and name. */
export interface Payee {
  readonly id: string;
  readonly name: string;
}

/** A purchase, signed once: this cart, at this shop, for this total, before it expires. */
export interface Payment {
  readonly v: 1;
  readonly kind: "buy";
  /** New for every payment; the shop pays for each one only once. */
  readonly id: string;
  readonly shop: Payee;
  /** The shop's id for the cart it priced. */
  readonly cart: string;
  readonly items: readonly PaymentItem[];
  readonly total: string;
  readonly currency: string;
  /** When the signature stops counting (UTC, to the second). */
  readonly expires: string;
}

/** Linking a board to your PayPal at a shop: from then on, the shop takes this board's signature for your carts. */
export interface LinkRequest {
  readonly v: 1;
  readonly kind: "link";
  readonly id: string;
  readonly shop: Payee;
  readonly expires: string;
}

export type Signable = Payment | LinkRequest;

/** The longest text a board is asked to sign (it fits the board's memory and one USB frame). */
export const MAX_SIGNABLE = 1_500;
/** The most lines a cart may have: the board shows each of them before you sign. */
export const MAX_ITEMS = 12;
const ID = /^[a-z]{2,8}_[A-Za-z0-9]{8,40}$/;
const SHOP_ID = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:\d{1,5})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const WHEN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** A new one-time id: "pay_…" for a payment, "link_…" for a link. */
export function signableId(prefix: "pay" | "link"): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

/** A time as the text takes it: UTC, to the second ("2026-10-29T10:15:00Z"). */
export function signableTime(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

/** The one way to write it: keys in this order, nothing else. */
export function signableText(signable: Signable): string {
  const shop = { id: signable.shop.id, name: signable.shop.name };
  if (signable.kind === "link") return JSON.stringify({ v: 1, kind: "link", id: signable.id, shop, expires: signable.expires });
  return JSON.stringify({
    v: 1,
    kind: "buy",
    id: signable.id,
    shop,
    cart: signable.cart,
    items: signable.items.map((item) => ({ name: item.name, qty: item.qty, price: item.price })),
    total: signable.total,
    currency: signable.currency,
    expires: signable.expires,
  });
}

/** A name a small screen can show and a person can read: printable, on one line, not too long. */
function plainName(value: unknown, what: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${what} should be a name of up to ${max} characters.`);
  if (/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/.test(value)) throw new Error(`${what} has characters a screen can't show plainly.`);
  if (value !== value.trim()) throw new Error(`${what} starts or ends with spaces.`);
  return value;
}

function exactKeys(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what} should be an object.`);
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => !keys.includes(key));
  if (extra.length) throw new Error(`${what} has something extra: ${extra.join(", ")}.`);
  const missing = keys.filter((key) => !(key in record));
  if (missing.length) throw new Error(`${what} is missing ${missing.join(", ")}.`);
  return record;
}

/**
 * A signable from its text, checked: every field there and nothing else, a cart whose lines add up to its total,
 * and written the one way (so the text is exactly what was signed). Throws with what's wrong.
 */
export function parseSignable(text: string): Signable {
  if (typeof text !== "string" || text.length > MAX_SIGNABLE) throw new Error(`The text to sign should be at most ${MAX_SIGNABLE} characters.`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("The text to sign isn't JSON.");
  }
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (kind !== "buy" && kind !== "link") throw new Error('The text to sign is neither a payment ("buy") nor a link ("link").');
  const record = exactKeys(value, kind === "buy" ? ["v", "kind", "id", "shop", "cart", "items", "total", "currency", "expires"] : ["v", "kind", "id", "shop", "expires"], "The text to sign");
  if (record.v !== 1) throw new Error("The text to sign is a version Huddle doesn't know.");
  if (typeof record.id !== "string" || !ID.test(record.id)) throw new Error("The text to sign needs a one-time id.");
  const shopRecord = exactKeys(record.shop, ["id", "name"], "The shop");
  if (typeof shopRecord.id !== "string" || !SHOP_ID.test(shopRecord.id)) throw new Error("The shop's id should be its web address's host, like shop.example.com.");
  const shop: Payee = { id: shopRecord.id, name: plainName(shopRecord.name, "The shop's name", 40) };
  if (typeof record.expires !== "string" || !WHEN.test(record.expires) || Number.isNaN(Date.parse(record.expires))) throw new Error("The text to sign needs when it expires, in UTC to the second.");
  let signable: Signable;
  if (kind === "link") {
    signable = { v: 1, kind, id: record.id, shop, expires: record.expires };
  } else {
    if (typeof record.cart !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(record.cart)) throw new Error("The payment needs the shop's id for its cart.");
    if (typeof record.currency !== "string" || !CURRENCY.test(record.currency)) throw new Error("The payment's currency should be a three-letter code, like USD.");
    if (!Array.isArray(record.items) || record.items.length < 1 || record.items.length > MAX_ITEMS) throw new Error(`A payment has between 1 and ${MAX_ITEMS} lines.`);
    let sum = 0;
    const items = record.items.map((raw, index): PaymentItem => {
      const item = exactKeys(raw, ["name", "qty", "price"], `Line ${index + 1}`);
      const name = plainName(item.name, `Line ${index + 1}'s name`, 60);
      if (typeof item.qty !== "number" || !Number.isInteger(item.qty) || item.qty < 1 || item.qty > 99) throw new Error(`Line ${index + 1} needs a quantity from 1 to 99.`);
      const each = typeof item.price === "string" ? cents(item.price) : null;
      if (each === null || each === 0 || decimal(each) !== item.price) throw new Error(`Line ${index + 1}'s price should be written like 12.00.`);
      sum += each * item.qty;
      return { name, qty: item.qty, price: item.price as string };
    });
    const total = typeof record.total === "string" ? cents(record.total) : null;
    if (total === null || decimal(total) !== record.total) throw new Error("The payment's total should be written like 32.50.");
    if (total !== sum) throw new Error(`The payment's lines come to ${decimal(sum)}, not the ${record.total} it says.`);
    signable = { v: 1, kind, id: record.id, shop, cart: record.cart, items, total: record.total, currency: record.currency, expires: record.expires };
  }
  if (signableText(signable) !== text) throw new Error("The text to sign isn't written the one way it can be (key order, spacing), so it can't be signed.");
  return signable;
}

/** Whether a signable has expired. */
export function expired(signable: Pick<Signable, "expires">, now = Date.now()): boolean {
  return Date.parse(signable.expires) <= now;
}

/** A board's public key: the uncompressed P-256 point (65 bytes, starting 0x04), base64url, as the board sends it. */
export function boardKey(raw: string): KeyObject {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error("A board's key should be base64url.");
  const bytes = Buffer.from(raw, "base64url");
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error("A board's key should be a P-256 public key, uncompressed (65 bytes).");
  try {
    return createPublicKey({ key: { kty: "EC", crv: "P-256", x: bytes.subarray(1, 33).toString("base64url"), y: bytes.subarray(33).toString("base64url") }, format: "jwk" });
  } catch {
    throw new Error("That isn't a point on P-256, so it can't be a board's key.");
  }
}

/**
 * A key's fingerprint, the same on the board's screen and in the canvas so you can see they match: the first
 * 8 bytes of the SHA-256 of the raw key, in hex, in fours ("1A2B 3C4D 5E6F 7A8B").
 */
export function fingerprint(raw: string): string {
  const hex = createHash("sha256").update(Buffer.from(raw, "base64url")).digest("hex").slice(0, 16).toUpperCase();
  return hex.match(/.{4}/g)!.join(" ");
}

/**
 * Whether `signature` is the board's signature of exactly this text: ECDSA P-256 with SHA-256 over its UTF-8
 * bytes, as r and s side by side (64 bytes, base64url), which is what WebCrypto and the board's mbedTLS give.
 */
export function signedBy(text: string, signature: string, raw: string): boolean {
  if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  let key: KeyObject;
  try {
    key = boardKey(raw);
  } catch {
    return false;
  }
  try {
    return verify("sha256", Buffer.from(text, "utf8"), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

const SYMBOLS: Readonly<Record<string, string>> = { USD: "$", EUR: "€", GBP: "£", INR: "₹", JPY: "¥", AUD: "A$", CAD: "C$" };

/** An amount with its currency, the way a person reads it: "$32.50", or "32.50 CHF". */
export function amountText(value: string, currency: string): string {
  const symbol = SYMBOLS[currency];
  return symbol ? `${symbol}${value}` : `${value} ${currency}`;
}

/** What a signable asks, in one line: "Pay $32.50 to Bean & Leaf: 2× House blend beans, 1 lb; 1× Paper filters". */
export function signableLine(signable: Signable): string {
  if (signable.kind === "link") return `Link your PayPal at ${signable.shop.name} to this board`;
  const items = signable.items.map((item) => `${item.qty}× ${item.name}`).join("; ");
  return `Pay ${amountText(signable.total, signable.currency)} to ${signable.shop.name}: ${items}`;
}
