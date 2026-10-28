import { dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import { PayPal } from "@huddle/core";
import { readCatalog } from "./catalog.ts";
import { shopApp } from "./shop.ts";
import { ShopStore } from "./store.ts";

/**
 * Bean & Leaf on its own, as a shop would run apart from your Huddle:
 *
 *   SHOP_PORT            default 7800
 *   SHOP_HOST            default 127.0.0.1
 *   SHOP_PUBLIC_URL      how payers and Huddle reach it (default http://localhost:<port>): PayPal sends payers back
 *                        under it, and its host is the shop's id in what boards sign
 *   SHOP_DB              where it keeps carts, linked boards and orders (default shop.db)
 *   SHOP_CATALOG         what it sells (default the catalog.json beside this package)
 *   SHOP_ADMIN_TOKEN     for its own pages: every order, and refunds
 *   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET   its PayPal app (the sandbox's, from PayPal's Developer Dashboard)
 *   PAYPAL_ENVIRONMENT   sandbox (default) or live
 *   PAYPAL_WEBHOOK_ID    the webhook added for <SHOP_PUBLIC_URL>/paypal/webhook, to check PayPal's events with
 */

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;
const port = Number(env("SHOP_PORT") ?? 7800);
const host = env("SHOP_HOST") ?? "127.0.0.1";
const publicUrl = env("SHOP_PUBLIC_URL") ?? `http://localhost:${port}`;
const catalog = readCatalog(env("SHOP_CATALOG") ?? join(dirname(new URL(import.meta.url).pathname), "..", "catalog.json"));
const paypal = PayPal.fromEnv();
const app = shopApp({
  catalog,
  store: new ShopStore(env("SHOP_DB") ?? "shop.db"),
  paypal,
  publicUrl,
  ...(env("SHOP_ADMIN_TOKEN") ? { adminToken: env("SHOP_ADMIN_TOKEN")! } : {}),
  ...(env("PAYPAL_WEBHOOK_ID") ? { webhookId: env("PAYPAL_WEBHOOK_ID")! } : {}),
});

serve({ fetch: app.fetch, hostname: host, port }, () => {
  console.log(`${catalog.name} is open at ${publicUrl} (${catalog.products.length} products; PayPal ${paypal ? (paypal.sandbox ? "sandbox" : "live") : "not set up: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET"}).`);
});
