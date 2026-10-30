import type { Payee } from "./countersign.ts";

/**
 * A shop that sells to agents and charges only for carts your board signed (Bean & Leaf, packages/shop, is
 * one), reached over HTTP like any other: look through what it sells, have a cart priced, link your board to
 * your PayPal there, and check out with the board's signature. The shop prices carts, never Huddle or an
 * assistant, and the shop checks the signature again before it charges.
 */

export interface ShopProduct {
  readonly sku: string;
  readonly name: string;
  /** For one ("12.00"). */
  readonly price: string;
  readonly currency: string;
  readonly tags: readonly string[];
}

/** A cart as the shop priced it. */
export interface PricedCart {
  readonly id: string;
  readonly shop: Payee;
  readonly items: readonly { readonly sku: string; readonly name: string; readonly qty: number; readonly price: string }[];
  readonly total: string;
  readonly currency: string;
  /** When its prices stop holding. */
  readonly expires: string;
}

export interface ShopOrder {
  readonly id: string;
  /** The payment's one-time id. */
  readonly payment: string;
  readonly cart: string;
  /** The fingerprint of the board that signed it. */
  readonly board: string;
  /** paid, or pending while PayPal reviews it; charging while PayPal is asked; failed, refunded, reversed. */
  readonly status: string;
  readonly total: string;
  readonly currency: string;
  readonly paypal: { readonly orderId: string | null; readonly captureId: string | null };
  readonly error: string | null;
}

/** What the shop said no with: its own words, and the order when there is one. */
export class ShopError extends Error {
  readonly status: number;
  readonly order: ShopOrder | null;
  constructor(message: string, status: number, order: ShopOrder | null = null) {
    super(message);
    this.status = status;
    this.order = order;
  }
}

export interface ShopClient {
  readonly url: string;
  /** The shop as boards see it, what it sells in, and whether its PayPal is set up. */
  about(): Promise<{ readonly shop: Payee; readonly currency: string; readonly paypal: string | null; readonly about: string }>;
  search(ask: string, limit?: number): Promise<{ readonly shop: Payee; readonly products: readonly ShopProduct[] }>;
  price(items: readonly CartLine[]): Promise<PricedCart>;
  /** Pays for a priced cart with the board's signature of the payment written for it. */
  checkout(signed: { readonly text: string; readonly signature: string; readonly key: string }): Promise<ShopOrder>;
  /** Starts linking a board: the text it signs. */
  startLink(key: string): Promise<{ readonly id: string; readonly text: string; readonly expires: string }>;
  /** The board signed the link: PayPal's page, for saving your PayPal with the shop, to open next. */
  signedLink(id: string, signature: string, returnUrl?: string): Promise<{ readonly approveUrl: string }>;
  link(id: string): Promise<{ readonly id: string; readonly status: string; readonly paypal: string | null; readonly error: string | null }>;
  /** Whether a board is linked to a PayPal at the shop. */
  board(key: string): Promise<{ readonly linked: boolean; readonly paypal: string | null }>;
}

/** One line to have priced: what, and how many. */
export interface CartLine {
  readonly sku: string;
  readonly qty: number;
}

/** A shop's address with nothing after it but its own paths. */
function base(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("A shop's address starts with http:// or https://.");
  return parsed.toString().replace(/\/+$/, "");
}

export function shopClient(url: string, fetcher: typeof fetch = globalThis.fetch): ShopClient {
  const root = base(url);
  const call = async <T>(what: string, method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
    let response: Response;
    try {
      response = await fetcher(`${root}${path}`, {
        method,
        headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new Error(`The shop at ${root} couldn't be reached to ${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = (await response.json().catch(() => null)) as (T & { error?: unknown; order?: ShopOrder }) | null;
    if (!response.ok) {
      const said = typeof parsed?.error === "string" ? parsed.error : `it answered ${response.status}`;
      throw new ShopError(`The shop didn't ${what}: ${said}`, response.status, parsed?.order ?? null);
    }
    if (!parsed) throw new Error(`The shop answered ${what} with something that isn't JSON.`);
    return parsed;
  };
  return {
    url: root,
    about: () => call("say what it is", "GET", "/"),
    search: (ask, limit = 8) => call("search its catalog", "GET", `/catalog?q=${encodeURIComponent(ask.slice(0, 500))}&limit=${limit}`),
    price: async (items) => (await call<{ cart: PricedCart }>("price the cart", "POST", "/carts", { items })).cart,
    checkout: async (signed) => (await call<{ order: ShopOrder }>("take the payment", "POST", "/checkout", signed)).order,
    startLink: async (key) => (await call<{ link: { id: string; text: string; expires: string } }>("start linking the board", "POST", "/links", { key })).link,
    signedLink: (id, signature, returnUrl) => call("take the board's signature of the link", "POST", `/links/${encodeURIComponent(id)}/signed`, { signature, ...(returnUrl ? { returnUrl } : {}) }),
    link: async (id) => (await call<{ link: { id: string; status: string; paypal: string | null; error: string | null } }>("say how the link went", "GET", `/links/${encodeURIComponent(id)}`)).link,
    board: (key) => call("say whether the board is linked", "POST", "/boards", { key }),
  };
}

/**
 * The lines of a cart from what a step said: JSON as a list of { sku, qty }, or an object with such a list as
 * `items` (an assistant's answer, `{{pick.data}}`). A line without qty is one of it. Throws with what's wrong.
 */
export function cartLines(value: string): CartLine[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('the cart should be JSON, like [{ "sku": "beans-house", "qty": 2 }]');
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { items?: unknown } | null)?.items;
  if (!Array.isArray(list) || list.length === 0) throw new Error('the cart should list what to buy, like [{ "sku": "beans-house", "qty": 2 }]');
  return list.map((raw, index) => {
    const line = (raw ?? {}) as { sku?: unknown; qty?: unknown };
    if (typeof line.sku !== "string" || !line.sku.trim()) throw new Error(`line ${index + 1} of the cart needs the product's sku`);
    const qty = line.qty ?? 1;
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1) throw new Error(`line ${index + 1} of the cart needs a whole quantity of one or more`);
    return { sku: line.sku.trim(), qty };
  });
}
