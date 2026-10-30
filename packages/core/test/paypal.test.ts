import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cents, decimal, PayPal, PayPalError, PAYPAL_LIVE, PAYPAL_SANDBOX } from "../src/paypal.ts";

const ID = "AbcClientId";
const SECRET = "shh-client-secret-123";

interface Call {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/**
 * A stand-in PayPal sandbox: OAuth, Vault v3 and Orders v2 as PayPal answers them. `orderStatus` is what a new
 * order comes back as (a saved PayPal is usually COMPLETED at once); `routes` overrides any path.
 */
function fakePayPal(options: { readonly orderStatus?: string; readonly captureStatus?: string; readonly routes?: Record<string, (call: Call) => Response>; readonly tokenSeconds?: number } = {}) {
  const calls: Call[] = [];
  let tokens = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]));
    const raw = init?.body === undefined ? undefined : String(init.body);
    const body = raw === undefined ? undefined : headers["content-type"] === "application/json" ? JSON.parse(raw) : raw;
    const call: Call = { method: init?.method ?? "GET", path: parsed.pathname, headers, body };
    calls.push(call);
    const override = options.routes?.[`${call.method} ${call.path}`];
    if (override) return override(call);
    if (call.path === "/v1/oauth2/token") {
      if (headers.authorization !== `Basic ${Buffer.from(`${ID}:${SECRET}`).toString("base64")}`) return Response.json({ error: "invalid_client", error_description: "Client Authentication failed" }, { status: 401 });
      tokens += 1;
      return Response.json({ access_token: `A21.token-${tokens}`, token_type: "Bearer", expires_in: options.tokenSeconds ?? 32_400 });
    }
    if (!headers.authorization?.startsWith("Bearer A21.token-")) return Response.json({ name: "AUTHENTICATION_FAILURE", message: "Authentication failed due to invalid authentication credentials." }, { status: 401 });
    if (call.method === "POST" && call.path === "/v3/vault/setup-tokens") {
      return Response.json(
        {
          id: "5C991763VB2781612",
          customer: { id: "customer_4029352050" },
          status: "PAYER_ACTION_REQUIRED",
          links: [
            { href: "https://www.sandbox.paypal.com/agreements/approve?approval_session_id=5C991763VB2781612", rel: "approve", method: "GET" },
            { href: `${PAYPAL_SANDBOX}/v3/vault/setup-tokens/5C991763VB2781612`, rel: "self", method: "GET" },
          ],
        },
        { status: 201 },
      );
    }
    if (call.method === "POST" && call.path === "/v3/vault/payment-tokens") {
      return Response.json(
        { id: "8kk8451t", customer: { id: "customer_4029352050" }, payment_source: { paypal: { email_address: "buyer@personal.example.com", payer_id: "QYR5Z8XDVJNXQ" } } },
        { status: 201 },
      );
    }
    if (call.method === "POST" && call.path === "/v2/checkout/orders") {
      const status = options.orderStatus ?? "COMPLETED";
      const amount = (body as { purchase_units: { amount: unknown }[] }).purchase_units[0]!.amount;
      return Response.json(
        {
          id: "5O190127TN364715T",
          status,
          purchase_units: status === "COMPLETED" ? [{ payments: { captures: [{ id: "3C679366HH908993F", status: options.captureStatus ?? "COMPLETED", amount }] } }] : [{}],
        },
        { status: 201 },
      );
    }
    if (call.method === "POST" && /^\/v2\/checkout\/orders\/[^/]+\/capture$/.test(call.path)) {
      return Response.json({ id: "5O190127TN364715T", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "3C679366HH908993F", status: "COMPLETED" }] } }] }, { status: 201 });
    }
    if (call.method === "POST" && /^\/v2\/payments\/captures\/[^/]+\/refund$/.test(call.path)) return Response.json({ id: "1JU08902781691411", status: "COMPLETED" }, { status: 201 });
    if (call.method === "POST" && call.path === "/v1/notifications/verify-webhook-signature") {
      return Response.json({ verification_status: (body as { transmission_sig: string }).transmission_sig === "good" ? "SUCCESS" : "FAILURE" });
    }
    return Response.json({ name: "RESOURCE_NOT_FOUND", message: "The specified resource does not exist." }, { status: 404 });
  }) as typeof fetch;
  return { fetcher, calls };
}

const paypal = (fake: ReturnType<typeof fakePayPal>, now?: () => number) => new PayPal({ clientId: ID, clientSecret: SECRET, fetcher: fake.fetcher, ...(now ? { now } : {}) });

describe("amounts", () => {
  it("are whole cents in, PayPal's decimal strings out", () => {
    assert.equal(cents("32.50"), 3250);
    assert.equal(cents("12.5"), 1250);
    assert.equal(cents("7"), 700);
    assert.equal(cents("0.05"), 5);
    assert.equal(cents("1.234"), null);
    assert.equal(cents("-3.00"), null);
    assert.equal(cents("1e3"), null);
    assert.equal(decimal(3250), "32.50");
    assert.equal(decimal(5), "0.05");
    assert.equal(decimal(0), "0.00");
    assert.throws(() => decimal(1.5));
  });
});

describe("the PayPal client", () => {
  it("is the sandbox unless told otherwise, and needs its credentials", () => {
    assert.equal(new PayPal({ clientId: ID, clientSecret: SECRET }).base, PAYPAL_SANDBOX);
    assert.equal(new PayPal({ clientId: ID, clientSecret: SECRET, sandbox: false }).base, PAYPAL_LIVE);
    assert.throws(() => new PayPal({ clientId: " ", clientSecret: SECRET }), /client id and secret/);
    assert.equal(PayPal.fromEnv({}), null);
    assert.equal(PayPal.fromEnv({ PAYPAL_CLIENT_ID: ID, PAYPAL_CLIENT_SECRET: SECRET })?.sandbox, true);
    assert.equal(PayPal.fromEnv({ PAYPAL_CLIENT_ID: ID, PAYPAL_CLIENT_SECRET: SECRET, PAYPAL_ENVIRONMENT: "live" })?.sandbox, false);
    assert.throws(() => PayPal.fromEnv({ PAYPAL_CLIENT_ID: ID, PAYPAL_CLIENT_SECRET: SECRET, PAYPAL_ENVIRONMENT: "staging" }), /sandbox or live/);
  });

  it("signs in once and reuses the token until just before it expires", async () => {
    const fake = fakePayPal({ tokenSeconds: 120 });
    let clock = 1_000_000;
    const client = paypal(fake, () => clock);
    await client.startSaving({ returnUrl: "https://shop.example/back", cancelUrl: "https://shop.example/cancel", brand: "Bean & Leaf", description: "Pay Bean & Leaf with PayPal" });
    await client.savePayPal("5C991763VB2781612");
    assert.equal(fake.calls.filter((call) => call.path === "/v1/oauth2/token").length, 1);
    const signIn = fake.calls[0]!;
    assert.equal(signIn.headers["content-type"], "application/x-www-form-urlencoded");
    assert.equal(signIn.body, "grant_type=client_credentials");
    clock += 61_000; // past expires_in less a minute
    await client.savePayPal("5C991763VB2781612");
    assert.equal(fake.calls.filter((call) => call.path === "/v1/oauth2/token").length, 2);
    assert.equal(fake.calls.at(-1)!.headers.authorization, "Bearer A21.token-2");
  });

  it("signs in again once when PayPal stops taking its token", async () => {
    let refused = false;
    const fake = fakePayPal({
      routes: {
        "POST /v3/vault/payment-tokens": (call) => {
          if (!refused) {
            refused = true;
            return Response.json({ name: "AUTHENTICATION_FAILURE", message: "Token expired" }, { status: 401 });
          }
          assert.equal(call.headers.authorization, "Bearer A21.token-2");
          return Response.json({ id: "8kk8451t" }, { status: 201 });
        },
      },
    });
    const saved = await paypal(fake).savePayPal("5C991763VB2781612");
    assert.equal(saved.vaultId, "8kk8451t");
  });

  it("says PayPal couldn't be reached when signing in fails on the way, as for any call, so it can be told from a no", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await assert.rejects(new PayPal({ clientId: ID, clientSecret: SECRET, fetcher: down }).savePayPal("5C991763VB2781612"), (error: unknown) => {
      assert.ok(!(error instanceof PayPalError));
      assert.match((error as Error).message, /^PayPal couldn't be reached to sign Huddle in: fetch failed$/);
      return true;
    });
  });

  it("says which credentials are wrong, without the secret", async () => {
    const fake = fakePayPal();
    const client = new PayPal({ clientId: ID, clientSecret: "wrong-secret", fetcher: fake.fetcher });
    await assert.rejects(client.savePayPal("5C991763VB2781612"), (error: unknown) => {
      assert.ok(error instanceof PayPalError);
      assert.equal(error.code, "invalid_client");
      assert.match(error.message, /PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET/);
      assert.doesNotMatch(error.message, /wrong-secret/);
      return true;
    });
  });

  it("starts saving a payer's PayPal with a page for them to approve, for later charges by the shop", async () => {
    const fake = fakePayPal();
    const started = await paypal(fake).startSaving({ returnUrl: "https://shop.example/back?link=l1", cancelUrl: "https://shop.example/cancel?link=l1", brand: "Bean & Leaf", description: "Bean & Leaf charges this PayPal for carts your board signs" });
    assert.equal(started.setupTokenId, "5C991763VB2781612");
    assert.match(started.approveUrl, /^https:\/\/www\.sandbox\.paypal\.com\/agreements\/approve/);
    const call = fake.calls.find((one) => one.path === "/v3/vault/setup-tokens")!;
    const source = (call.body as { payment_source: { paypal: Record<string, unknown> } }).payment_source.paypal;
    assert.equal(source.usage_type, "MERCHANT");
    assert.deepEqual((source.experience_context as Record<string, unknown>).return_url, "https://shop.example/back?link=l1");
    assert.ok(call.headers["paypal-request-id"], "a request id, so a retry doesn't make a second token");
  });

  it("finishes saving it: the setup token becomes the payment token orders are charged with", async () => {
    const fake = fakePayPal();
    const saved = await paypal(fake).savePayPal("5C991763VB2781612");
    assert.deepEqual(saved, { vaultId: "8kk8451t", customerId: "customer_4029352050", email: "buyer@personal.example.com", payerId: "QYR5Z8XDVJNXQ" });
    assert.deepEqual(fake.calls.at(-1)!.body, { payment_source: { token: { id: "5C991763VB2781612", type: "SETUP_TOKEN" } } });
    await assert.rejects(paypal(fake).savePayPal("../v1/oauth2"), /isn't a PayPal setup token id/);
  });

  it("charges a saved PayPal for exactly the items it's given, once per invoice id", async () => {
    const fake = fakePayPal();
    const charge = await paypal(fake).charge({
      vaultId: "8kk8451t",
      currency: "USD",
      invoiceId: "pay_7c1e2a",
      customId: "cart_91",
      description: "Bean & Leaf",
      items: [
        { name: "House blend beans, 1 lb", sku: "beans-house", quantity: 2, unitAmount: "12.00" },
        { name: "Paper filters", sku: "filters", quantity: 1, unitAmount: "8.5" },
      ],
    });
    assert.deepEqual(charge, { orderId: "5O190127TN364715T", status: "COMPLETED", captureId: "3C679366HH908993F", captureStatus: "COMPLETED", amount: { currency_code: "USD", value: "32.50" } });
    const order = fake.calls.find((call) => call.path === "/v2/checkout/orders")!;
    const unit = (order.body as { purchase_units: Record<string, unknown>[] }).purchase_units[0]!;
    assert.deepEqual(unit.amount, { currency_code: "USD", value: "32.50", breakdown: { item_total: { currency_code: "USD", value: "32.50" } } });
    assert.equal(unit.invoice_id, "pay_7c1e2a");
    assert.deepEqual((unit.items as Record<string, unknown>[])[1], { name: "Paper filters", quantity: "1", unit_amount: { currency_code: "USD", value: "8.50" }, sku: "filters", category: "PHYSICAL_GOODS" });
    assert.deepEqual((order.body as { payment_source: unknown }).payment_source, { paypal: { vault_id: "8kk8451t" } });
    assert.equal(order.headers["paypal-request-id"], "pay_7c1e2a");
    assert.equal(order.headers.prefer, "return=representation");
  });

  it("captures an order PayPal made but didn't take the money for yet", async () => {
    const fake = fakePayPal({ orderStatus: "CREATED" });
    const charge = await paypal(fake).charge({ vaultId: "8kk8451t", currency: "USD", invoiceId: "pay_2", items: [{ name: "Mug", quantity: 1, unitAmount: "14.00" }] });
    assert.equal(charge.captureId, "3C679366HH908993F");
    assert.ok(fake.calls.some((call) => call.path === "/v2/checkout/orders/5O190127TN364715T/capture"));
  });

  it("says pending when PayPal holds the money for a review, and fails when it's declined", async () => {
    const pending = await paypal(fakePayPal({ captureStatus: "PENDING" })).charge({ vaultId: "v", currency: "USD", invoiceId: "pay_3", items: [{ name: "Mug", quantity: 1, unitAmount: "14.00" }] });
    assert.equal(pending.status, "PENDING");
    await assert.rejects(
      paypal(fakePayPal({ captureStatus: "DECLINED" })).charge({ vaultId: "v", currency: "USD", invoiceId: "pay_4", items: [{ name: "Mug", quantity: 1, unitAmount: "14.00" }] }),
      /didn't take the payment.*capture declined/,
    );
    await assert.rejects(
      paypal(fakePayPal({ orderStatus: "PAYER_ACTION_REQUIRED" })).charge({ vaultId: "v", currency: "USD", invoiceId: "pay_5", items: [{ name: "Mug", quantity: 1, unitAmount: "14.00" }] }),
      /approve this one on its page/,
    );
  });

  it("won't send an order with no items, a bad price or a part quantity", async () => {
    const client = paypal(fakePayPal());
    await assert.rejects(client.charge({ vaultId: "v", currency: "USD", invoiceId: "i", items: [] }), /at least one item/);
    await assert.rejects(client.charge({ vaultId: "v", currency: "USD", invoiceId: "i", items: [{ name: "Mug", quantity: 1, unitAmount: "14.999" }] }), /no price PayPal can take/);
    await assert.rejects(client.charge({ vaultId: "v", currency: "USD", invoiceId: "i", items: [{ name: "Mug", quantity: 0.5, unitAmount: "14.00" }] }), /whole quantity/);
  });

  it("explains PayPal's own errors: the name, the fields at fault, and nothing secret", async () => {
    const fake = fakePayPal({
      routes: {
        "POST /v2/checkout/orders": () =>
          Response.json(
            {
              name: "UNPROCESSABLE_ENTITY",
              message: "The requested action could not be performed, semantically incorrect, or failed business validation.",
              debug_id: "c7b1d2f3a4",
              details: [{ field: "/purchase_units/@reference_id=='default'/invoice_id", issue: "DUPLICATE_INVOICE_ID", description: "Duplicate Invoice ID detected." }],
            },
            { status: 422 },
          ),
      },
    });
    await assert.rejects(paypal(fake).charge({ vaultId: "v", currency: "USD", invoiceId: "pay_1", items: [{ name: "Mug", quantity: 1, unitAmount: "14.00" }] }), (error: unknown) => {
      assert.ok(error instanceof PayPalError);
      assert.equal(error.status, 422);
      assert.equal(error.code, "UNPROCESSABLE_ENTITY");
      assert.equal(error.debugId, "c7b1d2f3a4");
      assert.match(error.message, /DUPLICATE_INVOICE_ID/);
      assert.doesNotMatch(error.message, new RegExp(SECRET));
      return true;
    });
  });

  it("refunds a capture, in full or in part", async () => {
    const fake = fakePayPal();
    const refund = await paypal(fake).refund("3C679366HH908993F", { amount: { currency_code: "USD", value: "8.50" }, note: "Filters were out of stock" });
    assert.deepEqual(refund, { id: "1JU08902781691411", status: "COMPLETED" });
    assert.deepEqual(fake.calls.at(-1)!.body, { amount: { currency_code: "USD", value: "8.50" }, note_to_payer: "Filters were out of stock" });
  });

  it("asks PayPal whether a webhook is really its own", async () => {
    const fake = fakePayPal();
    const event = { id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED" };
    const headers = (sig: string) => (name: string) =>
      ({ "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1", "paypal-transmission-id": "t-1", "paypal-transmission-sig": sig, "paypal-transmission-time": "2026-10-29T10:00:00Z" })[name.toLowerCase()];
    assert.equal(await paypal(fake).verifyWebhook(headers("good"), event, "WH-ID"), true);
    assert.equal(await paypal(fake).verifyWebhook(headers("forged"), event, "WH-ID"), false);
    const sent = fake.calls.findLast((call) => call.path === "/v1/notifications/verify-webhook-signature")!;
    assert.equal((sent.body as { webhook_id: string }).webhook_id, "WH-ID");
    assert.deepEqual((sent.body as { webhook_event: unknown }).webhook_event, event);
    // Without PayPal's headers it isn't PayPal's, and PayPal isn't even asked.
    const before = fake.calls.length;
    assert.equal(await paypal(fake).verifyWebhook(() => undefined, event, "WH-ID"), false);
    assert.equal(fake.calls.length, before);
  });
});
