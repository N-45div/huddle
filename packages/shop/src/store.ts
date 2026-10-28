import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fingerprint, type PaymentItem } from "@huddle/core";

/**
 * What the shop keeps, in its own SQLite file (never Huddle's): the carts it priced, the boards linked to a
 * PayPal saved with it, the links under way, and each order with the signed text and signature it was paid
 * for, so every charge can show what the payer's board agreed to.
 */

export interface Cart {
  readonly id: string;
  readonly items: readonly (PaymentItem & { readonly sku: string })[];
  readonly total: string;
  readonly currency: string;
  readonly expires: string;
  readonly createdAt: string;
}

/** A board linked to a PayPal saved with the shop: its carts are charged to that PayPal. */
export interface Customer {
  /** The board's public key (raw P-256 point, base64url). */
  readonly key: string;
  readonly fingerprint: string;
  readonly vaultId: string;
  readonly email: string | null;
  readonly linkedAt: string;
}

/** Linking a board: made, signed by the board, approved on PayPal's page, then linked (or cancelled). */
export interface Link {
  readonly id: string;
  readonly key: string;
  readonly text: string;
  readonly status: "unsigned" | "approving" | "linked" | "cancelled" | "failed";
  readonly setupTokenId: string | null;
  readonly returnUrl: string | null;
  readonly error: string | null;
  readonly expires: string;
  readonly createdAt: string;
}

export interface Order {
  readonly id: string;
  /** The payment's one-time id from the signed text: one order per payment, ever. */
  readonly paymentId: string;
  readonly cartId: string;
  readonly fingerprint: string;
  readonly text: string;
  readonly signature: string;
  readonly total: string;
  readonly currency: string;
  /** charging while PayPal is asked; then paid, pending, failed, refunded or reversed. */
  readonly status: "charging" | "paid" | "pending" | "failed" | "refunded" | "reversed";
  readonly paypalOrderId: string | null;
  readonly captureId: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
export const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString("hex")}`;

export class ShopStore {
  readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS carts (id TEXT PRIMARY KEY, items TEXT NOT NULL, total TEXT NOT NULL, currency TEXT NOT NULL, expires TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS customers (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, vault_id TEXT NOT NULL, email TEXT, linked_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS links (id TEXT PRIMARY KEY, key TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, setup_token TEXT, return_url TEXT, error TEXT, expires TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, payment_id TEXT NOT NULL UNIQUE, cart_id TEXT NOT NULL, fingerprint TEXT NOT NULL, text TEXT NOT NULL, signature TEXT NOT NULL, total TEXT NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL, paypal_order TEXT, capture_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS orders_capture ON orders (capture_id);
    `);
  }

  close(): void {
    this.db.close();
  }

  addCart(cart: Omit<Cart, "id" | "createdAt">): Cart {
    const saved: Cart = { ...cart, id: newId("cart"), createdAt: now() };
    this.db.prepare("INSERT INTO carts (id, items, total, currency, expires, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(saved.id, JSON.stringify(saved.items), saved.total, saved.currency, saved.expires, saved.createdAt);
    return saved;
  }

  cart(id: string): Cart | null {
    const row = this.db.prepare("SELECT * FROM carts WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    return { id: String(row.id), items: JSON.parse(String(row.items)) as Cart["items"], total: String(row.total), currency: String(row.currency), expires: String(row.expires), createdAt: String(row.created_at) };
  }

  addLink(key: string, linkText: string, id: string, expires: string): Link {
    this.db.prepare("INSERT INTO links (id, key, text, status, setup_token, return_url, error, expires, created_at) VALUES (?, ?, ?, 'unsigned', NULL, NULL, NULL, ?, ?)").run(id, key, linkText, expires, now());
    return this.link(id)!;
  }

  link(id: string): Link | null {
    const row = this.db.prepare("SELECT * FROM links WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      key: String(row.key),
      text: String(row.text),
      status: String(row.status) as Link["status"],
      setupTokenId: text(row.setup_token),
      returnUrl: text(row.return_url),
      error: text(row.error),
      expires: String(row.expires),
      createdAt: String(row.created_at),
    };
  }

  /** Moves a link on from the status it's expected to be in; false if it wasn't in it (answered twice, say). */
  moveLink(id: string, from: Link["status"], change: { readonly status: Link["status"]; readonly setupTokenId?: string; readonly returnUrl?: string; readonly error?: string }): boolean {
    const result = this.db
      .prepare("UPDATE links SET status = ?, setup_token = COALESCE(?, setup_token), return_url = COALESCE(?, return_url), error = ? WHERE id = ? AND status = ?")
      .run(change.status, change.setupTokenId ?? null, change.returnUrl ?? null, change.error ?? null, id, from);
    return Number(result.changes) === 1;
  }

  /** Links a board to a saved PayPal; linking the same board again points it at the new one. */
  saveCustomer(key: string, vaultId: string, email: string | null): Customer {
    this.db
      .prepare("INSERT INTO customers (key, fingerprint, vault_id, email, linked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET vault_id = excluded.vault_id, email = excluded.email, linked_at = excluded.linked_at")
      .run(key, fingerprint(key), vaultId, email, now());
    return this.customer(key)!;
  }

  customer(key: string): Customer | null {
    const row = this.db.prepare("SELECT * FROM customers WHERE key = ?").get(key) as Row | undefined;
    if (!row) return null;
    return { key: String(row.key), fingerprint: String(row.fingerprint), vaultId: String(row.vault_id), email: text(row.email), linkedAt: String(row.linked_at) };
  }

  /** Unlinks a board: its signature pays for nothing here from then on. */
  removeCustomer(key: string): boolean {
    return Number(this.db.prepare("DELETE FROM customers WHERE key = ?").run(key).changes) > 0;
  }

  /**
   * Starts an order for a payment, before PayPal is asked; null if that payment already has one (the
   * payment id is unique, so two checkouts of one signed payment can't both charge).
   */
  startOrder(order: Pick<Order, "paymentId" | "cartId" | "fingerprint" | "text" | "signature" | "total" | "currency">): Order | null {
    const id = newId("order");
    const at = now();
    const result = this.db
      .prepare("INSERT INTO orders (id, payment_id, cart_id, fingerprint, text, signature, total, currency, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'charging', ?, ?) ON CONFLICT (payment_id) DO NOTHING")
      .run(id, order.paymentId, order.cartId, order.fingerprint, order.text, order.signature, order.total, order.currency, at, at);
    return Number(result.changes) === 1 ? this.order(id) : null;
  }

  finishOrder(id: string, change: { readonly status: Order["status"]; readonly paypalOrderId?: string | null; readonly captureId?: string | null; readonly error?: string | null }): Order {
    this.db
      .prepare("UPDATE orders SET status = ?, paypal_order = COALESCE(?, paypal_order), capture_id = COALESCE(?, capture_id), error = ?, updated_at = ? WHERE id = ?")
      .run(change.status, change.paypalOrderId ?? null, change.captureId ?? null, change.error ?? null, now(), id);
    return this.order(id)!;
  }

  order(id: string): Order | null {
    const row = this.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as Row | undefined;
    return row ? toOrder(row) : null;
  }

  orderForPayment(paymentId: string): Order | null {
    const row = this.db.prepare("SELECT * FROM orders WHERE payment_id = ?").get(paymentId) as Row | undefined;
    return row ? toOrder(row) : null;
  }

  orderForCapture(captureId: string): Order | null {
    const row = this.db.prepare("SELECT * FROM orders WHERE capture_id = ?").get(captureId) as Row | undefined;
    return row ? toOrder(row) : null;
  }

  orders(limit = 100): Order[] {
    return (this.db.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map(toOrder);
  }
}

function toOrder(row: Row): Order {
  return {
    id: String(row.id),
    paymentId: String(row.payment_id),
    cartId: String(row.cart_id),
    fingerprint: String(row.fingerprint),
    text: String(row.text),
    signature: String(row.signature),
    total: String(row.total),
    currency: String(row.currency),
    status: String(row.status) as Order["status"],
    paypalOrderId: text(row.paypal_order),
    captureId: text(row.capture_id),
    error: text(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
