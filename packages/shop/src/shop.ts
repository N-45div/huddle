import { createHash, timingSafeEqual } from "node:crypto";
import {
  amountText,
  cents,
  decimal,
  expired,
  keyText,
  type LinkRequest,
  MAX_ITEMS,
  parseSignable,
  type Payee,
  PayPal,
  PayPalError,
  signableId,
  signableText,
  signableTime,
  signedBy,
} from "@huddle/core";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type Catalog, readCatalog, search } from "./catalog.ts";
import { type Cart, type Link, type Order, ShopStore } from "./store.ts";

export { type Catalog, parseCatalog, type Product, readCatalog, search } from "./catalog.ts";
export { ShopStore } from "./store.ts";

/**
 * Bean & Leaf: a demo shop that sells to agents, through PayPal's sandbox. An agent can look through the
 * catalog and have a cart priced, but the shop charges your PayPal only for a cart your board signed:
 *
 * 1. Link once. Your board signs the shop's link text, you approve saving your PayPal with the shop on
 *    PayPal's own page (Vault), and the shop keeps that saved PayPal against your board's public key.
 * 2. Buy. The agent has a cart priced, Huddle writes the payment for your board to show and sign (the shop,
 *    each line, the total, an expiry), and sends the signed text here. The shop checks the signature against the
 *    key linked to your PayPal and the text against its own cart, line by line, and only then charges your
 *    saved PayPal, once per payment.
 *
 * It runs on its own (`npm start -w @huddle/shop`), or inside Huddle's server at /shop, for one-service
 * demos; either way Huddle reaches it over HTTP only, as it would any shop. The shop keeps each order with the
 * text and signature it was paid for: proof, in a dispute, of what the payer's board agreed to.
 */

export interface ShopOptions {
  readonly catalog: Catalog;
  readonly store: ShopStore;
  /** The shop's PayPal app (sandbox); without it the shop shows its catalog and prices carts, but can't link or charge. */
  readonly paypal: PayPal | null;
  /** Where the shop is reached from outside: PayPal sends payers back under it. */
  readonly publicUrl: string;
  /** The shop's id in what boards sign: its address's host unless given. */
  readonly id?: string;
  /** For the shop's own pages (all orders, refunds), as a Bearer token; without it they're closed. */
  readonly adminToken?: string;
  /** The id of the webhook added for the shop in PayPal's Developer Dashboard, to check PayPal's events with. */
  readonly webhookId?: string;
  readonly now?: () => number;
  /** How long a priced cart's prices hold (default 30 minutes). */
  readonly cartMinutes?: number;
}

/** The most one cart may come to, in cents: a demo shop has no business taking more. */
const MAX_CART_CENTS = 1_000_000;
const LINK_MINUTES = 10;

type Status = 200 | 201 | 202 | 400 | 401 | 402 | 404 | 409 | 410 | 502 | 503;
const fail = (c: Context, status: Status, error: string) => c.json({ error }, status);

async function body(c: Context): Promise<Record<string, unknown>> {
  const parsed: unknown = await c.req.json().catch(() => null);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

const cartView = (cart: Cart, shop: Payee) => ({ id: cart.id, shop, items: cart.items, total: cart.total, currency: cart.currency, expires: cart.expires });
const orderView = (order: Order) => ({
  id: order.id,
  payment: order.paymentId,
  cart: order.cartId,
  board: order.fingerprint,
  status: order.status,
  total: order.total,
  currency: order.currency,
  paypal: { orderId: order.paypalOrderId, captureId: order.captureId },
  error: order.error,
  createdAt: order.createdAt,
  updatedAt: order.updatedAt,
});
const linkView = (link: Link, email: string | null) => ({ id: link.id, status: link.status, expires: link.expires, error: link.error, paypal: email });

/** A web address of yours to send the payer back to, or null when it isn't one. */
function returnTo(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_000) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The address with these added to its query. */
function withQuery(address: string, query: Record<string, string>): string {
  const url = new URL(address);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

/** Whether two secrets match, in the same time whatever they hold. */
function same(given: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
/** A small page for the payer, when PayPal sends them back and there's nowhere of theirs to go on to. */
const page = (title: string, words: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1c1c1c;background:#faf7f2}h1{font-size:1.4rem}</style></head><body><h1>${escape(title)}</h1><p>${escape(words)}</p></body></html>`;

export function shopApp(options: ShopOptions): Hono {
  const { catalog, store } = options;
  const now = options.now ?? Date.now;
  const publicUrl = options.publicUrl.replace(/\/$/, "");
  const shop: Payee = { id: options.id ?? new URL(publicUrl).host, name: catalog.name };
  const cartMs = (options.cartMinutes ?? 30) * 60_000;
  const paypal = options.paypal;
  const noPayPal = (c: Context) => fail(c, 503, `${shop.name} can't take PayPal yet: its PayPal app isn't set up (PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET).`);
  const admin = (c: Context) => Boolean(options.adminToken) && same(c.req.header("authorization") ?? "", `Bearer ${options.adminToken}`);

  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => fail(c, 400, "That's too big for this shop.") }));

  /** What the shop is: its id and name as boards see them, what it sells in, and whether PayPal is set up. */
  app.get("/", (c) =>
    c.json({
      shop,
      about: catalog.about,
      currency: catalog.currency,
      paypal: paypal ? (paypal.sandbox ? "sandbox" : "live") : null,
      products: catalog.products.length,
    }),
  );

  app.get("/catalog", (c) => {
    const ask = c.req.query("q") ?? "";
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 8) || 8, 1), 50);
    const products = search(catalog, ask, limit).map((product) => ({ sku: product.sku, name: product.name, price: product.price, currency: catalog.currency, tags: product.tags }));
    return c.json({ shop, products });
  });

  /** Prices a cart from the catalog: the agent says what and how many, the shop says what it costs. */
  app.post("/carts", async (c) => {
    const { items } = await body(c);
    if (!Array.isArray(items) || items.length === 0) return fail(c, 400, 'Send the cart as { "items": [{ "sku": "beans-house", "qty": 2 }] }.');
    const lines = new Map<string, number>();
    for (const raw of items) {
      const item = (raw ?? {}) as { sku?: unknown; qty?: unknown };
      const product = catalog.products.find((one) => one.sku === item.sku);
      if (!product) return fail(c, 400, `${shop.name} has nothing with the sku ${JSON.stringify(item.sku)}; GET /catalog lists what it sells.`);
      const qty = item.qty ?? 1;
      if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1 || qty > 99) return fail(c, 400, `Say how many of "${product.name}" as a whole number from 1 to 99.`);
      lines.set(product.sku, (lines.get(product.sku) ?? 0) + qty);
    }
    if (lines.size > MAX_ITEMS) return fail(c, 400, `A cart has at most ${MAX_ITEMS} different things in it.`);
    let total = 0;
    const priced: Cart["items"][number][] = [];
    for (const [sku, qty] of lines) {
      if (qty > 99) return fail(c, 400, "At most 99 of one thing.");
      const product = catalog.products.find((one) => one.sku === sku)!;
      total += cents(product.price)! * qty;
      priced.push({ sku, name: product.name, qty, price: product.price });
    }
    if (total > MAX_CART_CENTS) return fail(c, 400, `${shop.name} takes carts of up to ${amountText(decimal(MAX_CART_CENTS), catalog.currency)}.`);
    const cart = store.addCart({ items: priced, total: decimal(total), currency: catalog.currency, expires: signableTime(now() + cartMs) });
    return c.json({ cart: cartView(cart, shop) }, 201);
  });

  app.get("/carts/:id", (c) => {
    const cart = store.cart(c.req.param("id"));
    return cart ? c.json({ cart: cartView(cart, shop) }) : fail(c, 404, "There's no such cart.");
  });

  /** Starts linking a board: the text it signs to say "this board pays for my carts here". */
  app.post("/links", async (c) => {
    let key: string;
    try {
      key = keyText(String((await body(c)).key ?? ""));
    } catch (error) {
      return fail(c, 400, error instanceof Error ? error.message : String(error));
    }
    const request: LinkRequest = { v: 1, kind: "link", id: signableId("link"), shop, expires: signableTime(now() + LINK_MINUTES * 60_000) };
    const link = store.addLink(key, signableText(request), request.id, request.expires);
    return c.json({ link: { id: link.id, text: link.text, expires: link.expires } }, 201);
  });

  /** The board signed the link: PayPal's page for saving the payer's PayPal with the shop, to open next. */
  app.post("/links/:id/signed", async (c) => {
    const link = store.link(c.req.param("id"));
    if (!link) return fail(c, 404, "There's no such link.");
    if (link.status !== "unsigned") return fail(c, 409, `This link is already ${link.status}.`);
    if (Date.parse(link.expires) <= now()) return fail(c, 410, "This link expired before it was signed; start again.");
    const { signature, returnUrl } = await body(c);
    if (!signedBy(link.text, String(signature ?? ""), link.key)) return fail(c, 401, "That isn't this board's signature of the link.");
    if (returnUrl !== undefined && !returnTo(returnUrl)) return fail(c, 400, "returnUrl should be an http(s) address.");
    if (!paypal) return noPayPal(c);
    const back = `${publicUrl}/links/${link.id}/back`;
    try {
      const started = await paypal.startSaving({
        returnUrl: back,
        cancelUrl: withQuery(back, { cancelled: "1" }),
        brand: shop.name,
        description: `${shop.name} charges this PayPal only for carts your board signs`,
        requestId: link.id,
      });
      if (!store.moveLink(link.id, "unsigned", { status: "approving", setupTokenId: started.setupTokenId, ...(returnTo(returnUrl) ? { returnUrl: returnTo(returnUrl)! } : {}) })) return fail(c, 409, "This link was signed twice at once.");
      return c.json({ link: linkView(store.link(link.id)!, null), approveUrl: started.approveUrl });
    } catch (error) {
      return fail(c, 502, error instanceof Error ? error.message : String(error));
    }
  });

  /** Where PayPal sends the payer back: their PayPal is saved, and linked to the board that signed. */
  app.get("/links/:id/back", async (c) => {
    const link = store.link(c.req.param("id"));
    const done = (title: string, words: string, query: Record<string, string>, status: 200 | 400 | 409 | 502 = 200) => {
      const target = link?.returnUrl;
      if (target) return c.redirect(withQuery(target, { ...query, shop: shop.id }), 303);
      return c.html(page(title, words), status);
    };
    if (!link) return c.html(page("Link not found", "This link isn't one this shop made."), 404);
    if (link.status === "linked") return done("Already linked", `Your PayPal is linked to your board at ${shop.name}.`, { paypal: "linked" });
    if (link.status !== "approving" || !link.setupTokenId) return done("Can't link this", `This link is ${link.status}; start again from Huddle.`, { paypal: link.status }, 409);
    if (c.req.query("cancelled")) {
      store.moveLink(link.id, "approving", { status: "cancelled" });
      return done("Not linked", "You didn't save your PayPal with the shop, so nothing was linked.", { paypal: "cancelled" });
    }
    const token = c.req.query("approval_token_id");
    if (token && token !== link.setupTokenId) return done("Can't link this", "PayPal sent back a different approval than this link's.", { paypal: "failed" }, 400);
    if (!paypal) return c.html(page("Can't link this", `${shop.name}'s PayPal isn't set up.`), 503);
    try {
      const saved = await paypal.savePayPal(link.setupTokenId, `save-${link.id}`);
      store.saveCustomer(link.key, saved.vaultId, saved.email);
      store.moveLink(link.id, "approving", { status: "linked" });
      return done("PayPal linked", `${shop.name} will charge ${saved.email ?? "your PayPal"} only for carts your board signs. You can close this page.`, { paypal: "linked" });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      store.moveLink(link.id, "approving", { status: "failed", error: why });
      return done("Couldn't link PayPal", why, { paypal: "failed" }, 502);
    }
  });

  app.get("/links/:id", (c) => {
    const link = store.link(c.req.param("id"));
    if (!link) return fail(c, 404, "There's no such link.");
    return c.json({ link: linkView(link, link.status === "linked" ? (store.customer(link.key)?.email ?? null) : null) });
  });

  /** Whether a board is linked here, by its key: so Huddle can say so before it asks the board to sign. */
  app.post("/boards", async (c) => {
    const { key } = await body(c);
    let customer = null;
    try {
      customer = store.customer(keyText(String(key ?? "")));
    } catch {
      // Not a key: not linked.
    }
    return c.json({ linked: Boolean(customer), paypal: customer?.email ?? null, since: customer?.linkedAt ?? null });
  });

  /**
   * Pays for a cart with a board's signature. Charged only when: the text is a payment to this shop, written the
   * one way; the board's key is linked to a PayPal here; the signature is that key's, of exactly that text; it
   * hasn't expired; and its lines, total and currency are the cart's own. Each payment is paid for once: sending
   * it again gives back the same order.
   */
  app.post("/checkout", async (c) => {
    const { text, signature, key: given } = await body(c);
    if (typeof text !== "string" || typeof signature !== "string" || typeof given !== "string") return fail(c, 400, "Send the signed payment as { text, signature, key }.");
    let key: string;
    try {
      key = keyText(given);
    } catch (error) {
      return fail(c, 400, error instanceof Error ? error.message : String(error));
    }
    let payment;
    try {
      payment = parseSignable(text);
    } catch (error) {
      return fail(c, 400, error instanceof Error ? error.message : String(error));
    }
    if (payment.kind !== "buy") return fail(c, 400, "That's not a payment.");
    if (payment.shop.id !== shop.id || payment.shop.name !== shop.name) return fail(c, 400, `That payment is to ${payment.shop.name} (${payment.shop.id}), not this shop.`);
    const customer = store.customer(key);
    if (!customer) return fail(c, 401, `This board isn't linked to a PayPal at ${shop.name}. Link it first.`);
    if (!signedBy(text, signature, key)) return fail(c, 401, "That isn't this board's signature of this payment, so nothing was charged.");

    const earlier = store.orderForPayment(payment.id);
    if (earlier) {
      if (earlier.fingerprint !== customer.fingerprint) return fail(c, 409, "This payment was already used by another board.");
      // Still with PayPal, or PayPal couldn't be reached last time: ask again (PayPal does a request it's seen once).
      if (earlier.status === "charging" && earlier.error && paypal) return charge(c, earlier, customer.vaultId);
      return c.json({ order: orderView(earlier) }, earlier.status === "charging" ? 202 : 200);
    }
    if (expired(payment, now())) return fail(c, 410, "This payment's signature expired before it reached the shop; nothing was charged.");
    const cart = store.cart(payment.cart);
    if (!cart) return fail(c, 409, "There's no such cart here.");
    if (Date.parse(payment.expires) > Date.parse(cart.expires)) return fail(c, 409, "The payment outlives the cart's prices; price the cart again.");
    const same =
      cart.total === payment.total &&
      cart.currency === payment.currency &&
      cart.items.length === payment.items.length &&
      cart.items.every((line, index) => line.name === payment.items[index]!.name && line.qty === payment.items[index]!.qty && line.price === payment.items[index]!.price);
    if (!same) return fail(c, 409, "The signed payment isn't this cart as the shop priced it, so nothing was charged.");
    if (!paypal) return noPayPal(c);
    const order = store.startOrder({ paymentId: payment.id, cartId: cart.id, fingerprint: customer.fingerprint, text, signature, total: payment.total, currency: payment.currency });
    // Another checkout of this payment got there first.
    if (!order) return c.json({ order: orderView(store.orderForPayment(payment.id)!) }, 202);
    return charge(c, order, customer.vaultId);
  });

  /** Charges the saved PayPal for an order's cart, and says how it went. */
  const charge = async (c: Context, order: Order, vaultId: string) => {
    const cart = store.cart(order.cartId)!;
    try {
      const result = await paypal!.charge({
        vaultId,
        currency: cart.currency,
        invoiceId: order.paymentId,
        customId: cart.id,
        description: `${shop.name}, signed by board ${order.fingerprint}`,
        items: cart.items.map((line) => ({ name: line.name, sku: line.sku, quantity: line.qty, unitAmount: line.price })),
      });
      const done = store.finishOrder(order.id, { status: result.status === "PENDING" ? "pending" : "paid", paypalOrderId: result.orderId, captureId: result.captureId, error: null });
      return c.json({ order: orderView(done) }, 201);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      // PayPal answered no: the order failed. PayPal couldn't be reached: it may yet have charged, so the order
      // stays with PayPal, and sending the payment again asks PayPal again, as the same request.
      if (error instanceof PayPalError || !/couldn't be reached/.test(why)) {
        const failed = store.finishOrder(order.id, { status: "failed", error: why });
        return c.json({ error: why, order: orderView(failed) }, 402);
      }
      store.finishOrder(order.id, { status: "charging", error: why });
      return fail(c, 502, `${why} Send the same signed payment again: it's never charged twice.`);
    }
  };

  app.get("/orders/:id", (c) => {
    const order = store.order(c.req.param("id"));
    return order ? c.json({ order: orderView(order) }) : fail(c, 404, "There's no such order.");
  });

  /** The shop's own: every order, with the signed text each was paid for. */
  app.get("/orders", (c) => {
    if (!admin(c)) return fail(c, 401, "This page is the shop's: send its admin token (SHOP_ADMIN_TOKEN).");
    return c.json({ orders: store.orders().map((order) => ({ ...orderView(order), text: order.text, signature: order.signature })) });
  });

  app.post("/orders/:id/refund", async (c) => {
    if (!admin(c)) return fail(c, 401, "Refunds are the shop's: send its admin token (SHOP_ADMIN_TOKEN).");
    const order = store.order(c.req.param("id"));
    if (!order) return fail(c, 404, "There's no such order.");
    if (order.status !== "paid" || !order.captureId) return fail(c, 409, `Only a paid order can be refunded; this one is ${order.status}.`);
    if (!paypal) return noPayPal(c);
    const { amount, note } = await body(c);
    const partial = typeof amount === "string" ? cents(amount) : null;
    if (amount !== undefined && (partial === null || partial === 0 || partial > cents(order.total)!)) return fail(c, 400, `Refund an amount up to ${order.total}, written like 8.50.`);
    try {
      const refund = await paypal.refund(order.captureId, {
        requestId: `refund-${order.id}-${amount ?? "all"}`,
        ...(partial !== null ? { amount: { currency_code: order.currency, value: decimal(partial) } } : {}),
        ...(typeof note === "string" ? { note } : {}),
      });
      const done = partial === null || partial === cents(order.total) ? store.finishOrder(order.id, { status: "refunded" }) : order;
      return c.json({ refund, order: orderView(done) });
    } catch (error) {
      return fail(c, 502, error instanceof Error ? error.message : String(error));
    }
  });

  /** PayPal's word on a payment after the fact: settled, denied, refunded, reversed. Checked with PayPal first. */
  app.post("/paypal/webhook", async (c) => {
    if (!paypal || !options.webhookId) return fail(c, 503, "This shop isn't taking PayPal's webhooks: set PAYPAL_WEBHOOK_ID to the webhook's id from the Developer Dashboard.");
    const event = (await body(c)) as { event_type?: unknown; resource?: { id?: unknown; invoice_id?: unknown; status?: unknown } };
    let genuine = false;
    try {
      genuine = await paypal.verifyWebhook((name) => c.req.header(name), event, options.webhookId);
    } catch (error) {
      return fail(c, 502, error instanceof Error ? error.message : String(error));
    }
    if (!genuine) return fail(c, 401, "PayPal says that webhook isn't its own.");
    const type = typeof event.event_type === "string" ? event.event_type : "";
    const statuses: Readonly<Record<string, Order["status"]>> = {
      "PAYMENT.CAPTURE.COMPLETED": "paid",
      "PAYMENT.CAPTURE.PENDING": "pending",
      "PAYMENT.CAPTURE.DENIED": "failed",
      "PAYMENT.CAPTURE.DECLINED": "failed",
      "PAYMENT.CAPTURE.REFUNDED": "refunded",
      "PAYMENT.CAPTURE.REVERSED": "reversed",
    };
    const status = statuses[type];
    if (!status) return c.json({ ok: true, ignored: type });
    const resource = event.resource ?? {};
    const order =
      (typeof resource.invoice_id === "string" ? store.orderForPayment(resource.invoice_id) : null) ??
      (typeof resource.id === "string" ? store.orderForCapture(resource.id) : null);
    if (!order) return c.json({ ok: true, ignored: "no order of this shop's" });
    const changed = store.finishOrder(order.id, { status, ...(type.startsWith("PAYMENT.CAPTURE.") && typeof resource.id === "string" && status !== "refunded" ? { captureId: resource.id } : {}), error: order.error });
    return c.json({ ok: true, order: orderView(changed) });
  });

  return app;
}

/**
 * Bean & Leaf inside Huddle's server, for a one-service demo: open when a PayPal app is set up
 * (PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET), or with HUDDLE_SHOP=on to look around without one; HUDDLE_SHOP=off
 * keeps it shut. Null when it's shut.
 */
export function demoShop(env: NodeJS.ProcessEnv, where: { readonly publicUrl: string; readonly db: string; readonly fetcher?: typeof fetch }): { readonly app: Hono; readonly name: string; readonly paypal: "sandbox" | "live" | null } | null {
  const setting = env.HUDDLE_SHOP?.trim().toLowerCase();
  const paypal = PayPal.fromEnv(env, where.fetcher);
  if (setting === "off" || (!paypal && setting !== "on")) return null;
  const catalog = readCatalog(env.SHOP_CATALOG?.trim() || new URL("../catalog.json", import.meta.url));
  const app = shopApp({
    catalog,
    store: new ShopStore(where.db),
    paypal,
    publicUrl: where.publicUrl,
    ...(env.SHOP_ADMIN_TOKEN?.trim() ? { adminToken: env.SHOP_ADMIN_TOKEN.trim() } : {}),
    ...(env.PAYPAL_WEBHOOK_ID?.trim() ? { webhookId: env.PAYPAL_WEBHOOK_ID.trim() } : {}),
  });
  return { app, name: catalog.name, paypal: paypal ? (paypal.sandbox ? "sandbox" : "live") : null };
}
