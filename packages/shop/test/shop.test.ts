import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import { type Payment, PayPal, signableText } from "@huddle/core";
import { parseCatalog, readCatalog, search } from "../src/catalog.ts";
import { demoShop, shopApp } from "../src/shop.ts";
import { ShopStore } from "../src/store.ts";

const CATALOG = readCatalog(new URL("../catalog.json", import.meta.url));
const SHOP = { id: "shop.test", name: "Bean & Leaf" };
const START = Date.parse("2026-10-29T10:00:00Z");

/** A board as the ESP32 makes one: its raw P-256 point, and r‖s signatures. */
function board() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const key = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
  return { key, sign: (text: string) => sign("sha256", Buffer.from(text, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly requestId: string | undefined;
}

/** A stand-in PayPal sandbox; `charge` decides what an order comes back as. */
function fakePayPal(charge: (body: Record<string, unknown>, attempt: number) => Response | "unreachable" = () => completed()) {
  const calls: Call[] = [];
  let orders = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" && headers["content-type"] === "application/json" ? JSON.parse(init.body) : init?.body;
    calls.push({ method: init?.method ?? "GET", path, body, requestId: headers["paypal-request-id"] });
    if (path === "/v1/oauth2/token") return Response.json({ access_token: "A21.test", expires_in: 32_400 });
    if (path === "/v3/vault/setup-tokens") return Response.json({ id: "SETUP123", status: "PAYER_ACTION_REQUIRED", links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/agreements/approve?approval_session_id=SETUP123" }] }, { status: 201 });
    if (path === "/v3/vault/payment-tokens") return Response.json({ id: "VAULT9", customer: { id: "cust_1" }, payment_source: { paypal: { email_address: "buyer@personal.example.com" } } }, { status: 201 });
    if (path === "/v2/checkout/orders") {
      orders += 1;
      const answer = charge(body as Record<string, unknown>, orders);
      if (answer === "unreachable") throw new TypeError("fetch failed");
      return answer;
    }
    if (/\/refund$/.test(path)) return Response.json({ id: "REFUND1", status: "COMPLETED" }, { status: 201 });
    if (path === "/v1/notifications/verify-webhook-signature") return Response.json({ verification_status: (body as { transmission_sig: string }).transmission_sig === "good" ? "SUCCESS" : "FAILURE" });
    return Response.json({ name: "RESOURCE_NOT_FOUND" }, { status: 404 });
  }) as typeof fetch;
  return { paypal: new PayPal({ clientId: "id", clientSecret: "secret", fetcher }), calls, charges: () => calls.filter((call) => call.path === "/v2/checkout/orders") };
}

const completed = (status = "COMPLETED") => Response.json({ id: "ORDER1", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAPTURE1", status }] } }] }, { status: 201 });

function shop(options: { readonly paypal?: ReturnType<typeof fakePayPal> | null; readonly adminToken?: string; readonly webhookId?: string } = {}) {
  let clock = START;
  const fake = options.paypal === undefined ? fakePayPal() : options.paypal;
  const store = new ShopStore();
  const app = shopApp({
    catalog: CATALOG,
    store,
    paypal: fake?.paypal ?? null,
    publicUrl: "http://shop.test/",
    now: () => clock,
    ...(options.adminToken ? { adminToken: options.adminToken } : {}),
    ...(options.webhookId ? { webhookId: options.webhookId } : {}),
  });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await app.request(path, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const type = response.headers.get("content-type") ?? "";
    return { status: response.status, body: (type.includes("json") ? await response.json() : await response.text()) as Record<string, any>, location: response.headers.get("location") };
  };
  /** Links a board to the buyer's sandbox PayPal, the whole way through. */
  const link = async (signer = board(), returnUrl = "http://huddle.test/wallet") => {
    const started = await call("POST", "/links", { key: signer.key });
    const signed = await call("POST", `/links/${started.body.link.id}/signed`, { signature: signer.sign(started.body.link.text), returnUrl });
    const back = await call("GET", `/links/${started.body.link.id}/back?approval_token_id=SETUP123&approval_session_id=s1`);
    return { signer, started, signed, back };
  };
  /** A cart priced by the shop, and the payment Huddle would write for it. */
  const cart = async (items: unknown = [{ sku: "beans-house", qty: 2 }, { sku: "filters", qty: 1 }]) => {
    const priced = await call("POST", "/carts", { items });
    const c = priced.body.cart;
    const payment: Payment = { v: 1, kind: "buy", id: `pay_${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`, shop: c.shop, cart: c.id, items: c.items.map((line: any) => ({ name: line.name, qty: line.qty, price: line.price })), total: c.total, currency: c.currency, expires: "2026-10-29T10:15:00Z" };
    return { priced, payment, text: signableText(payment) };
  };
  return { app, store, fake, call, link, cart, tick: (ms: number) => (clock += ms) };
}

describe("the shop's catalog", () => {
  it("finds what fits the words asked for, best first", () => {
    assert.deepEqual(search(CATALOG, "coffee beans", 3).map((product) => product.sku), ["beans-house", "beans-ethiopia", "beans-decaf"]);
    assert.equal(search(CATALOG, "something to help me sleep")[0]?.sku, "tea-chamomile");
    assert.equal(search(CATALOG, "filter")[0]?.sku, "filters");
    assert.equal(search(CATALOG, "").length, 8);
    assert.deepEqual(search(CATALOG, "spaceship"), []);
  });

  it("is checked when it's read", () => {
    assert.throws(() => parseCatalog({ name: "X", currency: "USD", products: [{ sku: "a", name: "A", price: "1.234" }] }), /needs a price/);
    assert.throws(() => parseCatalog({ name: "X", currency: "USD", products: [{ sku: "a", name: "A", price: "1.00" }, { sku: "a", name: "B", price: "2.00" }] }), /Two products/);
  });

  it("is open to anyone, with the shop's id as boards will see it", async () => {
    const { call } = shop();
    const card = await call("GET", "/");
    assert.deepEqual(card.body.shop, SHOP);
    assert.equal(card.body.paypal, "sandbox");
    const found = await call("GET", "/catalog?q=chai");
    assert.equal(found.body.products[0].sku, "tea-chai");
    assert.equal(found.body.products[0].currency, "USD");
  });
});

describe("a cart", () => {
  it("is priced by the shop, from its own catalog", async () => {
    const { call } = shop();
    const priced = await call("POST", "/carts", { items: [{ sku: "beans-house", qty: 1 }, { sku: "filters" }, { sku: "beans-house", qty: 1 }] });
    assert.equal(priced.status, 201);
    const cart = priced.body.cart;
    assert.deepEqual(cart.items, [
      { sku: "beans-house", name: "House blend beans, 1 lb", qty: 2, price: "12.00" },
      { sku: "filters", name: "Paper filters, 100", qty: 1, price: "8.50" },
    ]);
    assert.equal(cart.total, "32.50");
    assert.equal(cart.expires, "2026-10-29T10:30:00Z");
    assert.deepEqual((await call("GET", `/carts/${cart.id}`)).body.cart, cart);
  });

  it("won't price what the shop doesn't sell, or silly amounts of it", async () => {
    const { call } = shop();
    assert.match((await call("POST", "/carts", { items: [{ sku: "unicorn", qty: 1 }] })).body.error, /nothing with the sku "unicorn"/);
    assert.match((await call("POST", "/carts", { items: [{ sku: "mug", qty: 0 }] })).body.error, /1 to 99/);
    assert.match((await call("POST", "/carts", { items: [{ sku: "mug", qty: 60 }, { sku: "mug", qty: 60 }] })).body.error, /At most 99/);
    assert.match((await call("POST", "/carts", {})).body.error, /Send the cart/);
  });
});

describe("linking a board to your PayPal", () => {
  it("takes the board's signature, then PayPal's page, and sends you back linked", async () => {
    const { call, link, fake } = shop();
    const { signer, started, signed, back } = await link();
    assert.equal(started.status, 201);
    assert.deepEqual(JSON.parse(started.body.link.text).shop, SHOP);
    assert.equal(JSON.parse(started.body.link.text).kind, "link");
    assert.equal(signed.status, 200);
    assert.match(signed.body.approveUrl, /^https:\/\/www\.sandbox\.paypal\.com\//);
    const setup = fake!.calls.find((one) => one.path === "/v3/vault/setup-tokens")!;
    const context = (setup.body as any).payment_source.paypal.experience_context;
    assert.equal(context.return_url, `http://shop.test/links/${started.body.link.id}/back`);
    assert.equal(back.status, 303);
    assert.equal(back.location, "http://huddle.test/wallet?paypal=linked&shop=shop.test");
    assert.deepEqual((await call("POST", "/boards", { key: signer.key })).body, { linked: true, paypal: "buyer@personal.example.com", since: (await call("POST", "/boards", { key: signer.key })).body.since });
    assert.equal((await call("GET", `/links/${started.body.link.id}`)).body.link.status, "linked");
    // The same key with its spare end bits set another way is the same board, not a new one.
    const last = signer.key.at(-1)!;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const other = signer.key.slice(0, -1) + alphabet[(alphabet.indexOf(last) & ~3) | ((alphabet.indexOf(last) + 1) & 3)]!;
    assert.notEqual(other, signer.key);
    assert.equal((await call("POST", "/boards", { key: other })).body.linked, true);
  });

  it("won't link on another board's signature, after the link expires, or twice", async () => {
    const { call, tick } = shop();
    const mine = board();
    const started = await call("POST", "/links", { key: mine.key });
    const forged = await call("POST", `/links/${started.body.link.id}/signed`, { signature: board().sign(started.body.link.text) });
    assert.equal(forged.status, 401);
    const late = await call("POST", "/links", { key: mine.key });
    tick(11 * 60_000);
    assert.equal((await call("POST", `/links/${late.body.link.id}/signed`, { signature: mine.sign(late.body.link.text) })).status, 410);
    assert.equal((await call("POST", "/links", { key: "not-a-key" })).status, 400);
  });

  it("links nothing when you cancel on PayPal's page", async () => {
    const { call } = shop();
    const mine = board();
    const started = await call("POST", "/links", { key: mine.key });
    await call("POST", `/links/${started.body.link.id}/signed`, { signature: mine.sign(started.body.link.text) });
    const back = await call("GET", `/links/${started.body.link.id}/back?cancelled=1`);
    assert.equal(back.status, 200);
    assert.match(String(back.body), /save your PayPal with the shop, so nothing was linked/);
    assert.equal((await call("POST", "/boards", { key: mine.key })).body.linked, false);
  });

  it("says so plainly when the shop's PayPal isn't set up", async () => {
    const { call } = shop({ paypal: null });
    const mine = board();
    const started = await call("POST", "/links", { key: mine.key });
    const signed = await call("POST", `/links/${started.body.link.id}/signed`, { signature: mine.sign(started.body.link.text) });
    assert.equal(signed.status, 503);
    assert.match(signed.body.error, /PAYPAL_CLIENT_ID/);
  });
});

describe("checking out with a board's signature", () => {
  it("charges the linked PayPal for exactly the cart the board signed, once", async () => {
    const { call, link, cart, fake } = shop();
    const { signer } = await link();
    const { text, payment } = await cart();
    const paid = await call("POST", "/checkout", { text, signature: signer.sign(text), key: signer.key });
    assert.equal(paid.status, 201);
    assert.equal(paid.body.order.status, "paid");
    assert.deepEqual(paid.body.order.paypal, { orderId: "ORDER1", captureId: "CAPTURE1" });
    assert.equal(paid.body.order.payment, payment.id);
    const order = fake!.charges()[0]!;
    const unit = (order.body as any).purchase_units[0];
    assert.equal(unit.invoice_id, payment.id);
    assert.equal(unit.amount.value, "32.50");
    assert.deepEqual((order.body as any).payment_source, { paypal: { vault_id: "VAULT9" } });
    // The same signed payment again is the same order, not a second charge.
    const again = await call("POST", "/checkout", { text, signature: signer.sign(text), key: signer.key });
    assert.equal(again.status, 200);
    assert.equal(again.body.order.id, paid.body.order.id);
    assert.equal(fake!.charges().length, 1);
  });

  it("charges nothing when anything about the signature or the cart is off", async () => {
    const { call, link, cart, fake, tick } = shop();
    const { signer } = await link();
    const stranger = board();
    const { text, payment, priced } = await cart();
    const refusals: [string, Promise<{ status: number; body: Record<string, any> }>, number, RegExp][] = [
      ["a board that isn't linked", call("POST", "/checkout", { text, signature: stranger.sign(text), key: stranger.key }), 401, /isn't linked/],
      ["another board's signature", call("POST", "/checkout", { text, signature: stranger.sign(text), key: signer.key }), 401, /isn't this board's signature/],
      ["a different total", call("POST", "/checkout", (() => {
        const cheaper = signableText({ ...payment, items: [{ ...payment.items[0]!, price: "1.00" }, payment.items[1]!], total: "10.50" });
        return { text: cheaper, signature: signer.sign(cheaper), key: signer.key };
      })()), 409, /isn't this cart/],
      ["a line the shop never priced", call("POST", "/checkout", (() => {
        const more = signableText({ ...payment, items: [...payment.items, { name: "Gift card, $200", qty: 1, price: "200.00" }], total: "232.50" });
        return { text: more, signature: signer.sign(more), key: signer.key };
      })()), 409, /isn't this cart/],
      ["another shop", call("POST", "/checkout", (() => {
        const elsewhere = signableText({ ...payment, shop: { id: "bean-and-leaf.example", name: "Bean & Leaf" } });
        return { text: elsewhere, signature: signer.sign(elsewhere), key: signer.key };
      })()), 400, /not this shop/],
      ["a payment that outlives the cart's prices", call("POST", "/checkout", (() => {
        const long = signableText({ ...payment, expires: "2026-10-29T11:00:00Z" });
        return { text: long, signature: signer.sign(long), key: signer.key };
      })()), 409, /outlives the cart/],
      ["a text written another way", call("POST", "/checkout", { text: text.replace("{", "{ "), signature: signer.sign(text.replace("{", "{ ")), key: signer.key }), 400, /one way/],
    ];
    for (const [what, pending, status, message] of refusals) {
      const answer = await pending;
      assert.equal(answer.status, status, what);
      assert.match(answer.body.error, message, what);
    }
    tick(16 * 60_000);
    const late = await call("POST", "/checkout", { text, signature: signer.sign(text), key: signer.key });
    assert.equal(late.status, 410);
    assert.equal(fake!.charges().length, 0, "PayPal was never asked to charge");
    assert.equal(priced.status, 201);
  });

  it("fails the order when PayPal declines, and says so", async () => {
    const declined = fakePayPal(() => completed("DECLINED"));
    const { call, link, cart } = shop({ paypal: declined });
    const { signer } = await link();
    const { text } = await cart();
    const answer = await call("POST", "/checkout", { text, signature: signer.sign(text), key: signer.key });
    assert.equal(answer.status, 402);
    assert.equal(answer.body.order.status, "failed");
    assert.match(answer.body.error, /capture declined/);
  });

  it("asks PayPal again, as the same request, when it couldn't be reached", async () => {
    const flaky = fakePayPal((_body, attempt) => (attempt === 1 ? "unreachable" : completed()));
    const { call, link, cart } = shop({ paypal: flaky });
    const { signer } = await link();
    const { text, payment } = await cart();
    const first = await call("POST", "/checkout", { text, signature: signer.sign(text), key: signer.key });
    assert.equal(first.status, 502);
    assert.match(first.body.error, /never charged twice/);
    const second = await call("POST", "/checkout", { text, signature: signer.sign(text), key: signer.key });
    assert.equal(second.status, 201);
    assert.equal(second.body.order.status, "paid");
    assert.deepEqual(flaky.charges().map((one) => one.requestId), [payment.id, payment.id]);
  });
});

describe("the shop's own pages", () => {
  it("are closed without the shop's admin token", async () => {
    const { call } = shop({ adminToken: "shop-admin-token-123" });
    assert.equal((await call("GET", "/orders")).status, 401);
    assert.equal((await call("GET", "/orders", undefined, { authorization: "Bearer wrong" })).status, 401);
    assert.equal((await call("GET", "/orders", undefined, { authorization: "Bearer shop-admin-token-123" })).status, 200);
    assert.equal((await shop().call("GET", "/orders", undefined, { authorization: "Bearer " })).status, 401, "no token set: closed");
  });

  it("keep each order with the text and signature it was paid for, and refund it", async () => {
    const { call, link, cart, fake } = shop({ adminToken: "shop-admin-token-123" });
    const { signer } = await link();
    const { text } = await cart();
    const signature = signer.sign(text);
    const paid = await call("POST", "/checkout", { text, signature, key: signer.key });
    const auth = { authorization: "Bearer shop-admin-token-123" };
    const listed = await call("GET", "/orders", undefined, auth);
    assert.equal(listed.body.orders[0].text, text);
    assert.equal(listed.body.orders[0].signature, signature);
    const partial = await call("POST", `/orders/${paid.body.order.id}/refund`, { amount: "8.50", note: "Filters were out of stock" }, auth);
    assert.equal(partial.status, 200);
    assert.equal(partial.body.order.status, "paid");
    assert.deepEqual((fake!.calls.at(-1)!.body as any).amount, { currency_code: "USD", value: "8.50" });
    assert.equal((await call("POST", `/orders/${paid.body.order.id}/refund`, { amount: "99.00" }, auth)).status, 400);
    const full = await call("POST", `/orders/${paid.body.order.id}/refund`, {}, auth);
    assert.equal(full.body.order.status, "refunded");
  });
});

describe("PayPal's webhooks", () => {
  it("are taken only when PayPal says they're its own, and move the order on", async () => {
    const { call, link, cart } = shop({ webhookId: "WH-123" });
    const { signer } = await link();
    const { text, payment } = await cart();
    const paid = await call("POST", "/checkout", { text, signature: signer.sign(text), key: signer.key });
    const event = { id: "WH-EVT-1", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "REFUND1", invoice_id: payment.id, status: "COMPLETED" } };
    const headers = (sig: string) => ({ "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/C", "paypal-transmission-id": "t1", "paypal-transmission-sig": sig, "paypal-transmission-time": "2026-10-29T10:05:00Z" });
    assert.equal((await call("POST", "/paypal/webhook", event, headers("forged"))).status, 401);
    const taken = await call("POST", "/paypal/webhook", event, headers("good"));
    assert.equal(taken.status, 200);
    assert.equal(taken.body.order.status, "refunded");
    assert.equal(taken.body.order.paypal.captureId, "CAPTURE1", "a refund's id isn't the capture's");
    assert.equal((await call("GET", `/orders/${paid.body.order.id}`)).body.order.status, "refunded");
    assert.equal((await shop().call("POST", "/paypal/webhook", event, headers("good"))).status, 503, "no webhook id: not taken");
  });
});

describe("Bean & Leaf inside Huddle", () => {
  const where = { publicUrl: "http://huddle.test/shop", db: ":memory:" };
  it("opens with a PayPal app set up, or when asked to, and stays shut otherwise", async () => {
    assert.equal(demoShop({}, where), null);
    const withPayPal = demoShop({ PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret" }, where);
    assert.equal(withPayPal?.paypal, "sandbox");
    assert.equal(withPayPal?.name, "Bean & Leaf");
    const card = (await (await withPayPal!.app.request("/")).json()) as { shop: { id: string } };
    assert.equal(card.shop.id, "huddle.test", "its id is Huddle's host when it runs inside Huddle");
    assert.equal(demoShop({ HUDDLE_SHOP: "on" }, where)?.paypal, null);
    assert.equal(demoShop({ HUDDLE_SHOP: "off", PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret" }, where), null);
  });
});
