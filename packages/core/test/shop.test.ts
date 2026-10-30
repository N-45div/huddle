import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shop } from "../src/connectors/shop.ts";
import { Assistant, assistantProblems } from "../src/schema.ts";
import { cartLines, shopClient, ShopError } from "../src/shop.ts";

const SHOP = { id: "shop.test", name: "Bean & Leaf" };

/** A stand-in shop: what it answers by method and path, and what it was sent. */
function fakeShop(routes: Record<string, (body: unknown) => Response>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const method = init?.method ?? "GET";
    calls.push({ method, path: `${parsed.pathname}${parsed.search}`, body });
    const route = routes[`${method} ${parsed.pathname}`];
    return route ? route(body) : Response.json({ error: "There's no such page." }, { status: 404 });
  }) as typeof fetch;
  return { fetcher, calls };
}

const beans = { sku: "beans-house", name: "House blend beans, 1 lb", price: "12.00", currency: "USD", tags: ["coffee"] };

describe("a shop as an assistant", () => {
  it("answers what it has that fits, one line each with its sku and price", async () => {
    const fake = fakeShop({ "GET /shop/catalog": () => Response.json({ shop: SHOP, products: [beans, { ...beans, sku: "filters", name: "Paper filters, 100", price: "8.50" }] }) });
    const assistant = Assistant.parse({ id: "beans", connector: "shop", url: "http://huddle.test/shop/" });
    const answer = await shop(fake.fetcher).send({ assistant, ask: "coffee beans and filters", memory: [] });
    assert.equal(answer.text, "Bean & Leaf (shop.test) has:\n- beans-house: House blend beans, 1 lb, $12.00\n- filters: Paper filters, 100, $8.50");
    assert.equal((answer.data as { products: unknown[] }).products.length, 2);
    assert.equal(fake.calls[0]!.path, "/shop/catalog?q=coffee%20beans%20and%20filters&limit=8");
  });

  it("says plainly when the shop has nothing that fits", async () => {
    const fake = fakeShop({ "GET /shop/catalog": () => Response.json({ shop: SHOP, products: [] }) });
    const answer = await shop(fake.fetcher).send({ assistant: Assistant.parse({ id: "beans", connector: "shop", url: "http://huddle.test/shop" }), ask: "a spaceship", memory: [] });
    assert.equal(answer.text, 'Bean & Leaf has nothing for "a spaceship".');
  });

  it("needs the shop's address", () => {
    assert.deepEqual(assistantProblems(Assistant.parse({ id: "beans", connector: "shop" })), ['assistant "beans" is a shop: give its address (url), like http://localhost:7700/shop']);
  });
});

describe("the shop client", () => {
  it("has the shop price a cart, and says what it priced", async () => {
    const cart = { id: "cart_1", shop: SHOP, items: [{ sku: "beans-house", name: beans.name, qty: 2, price: "12.00" }], total: "24.00", currency: "USD", expires: "2026-10-30T10:30:00Z" };
    const fake = fakeShop({ "POST /carts": () => Response.json({ cart }, { status: 201 }) });
    assert.deepEqual(await shopClient("http://shop.test", fake.fetcher).price([{ sku: "beans-house", qty: 2 }]), cart);
    assert.deepEqual(fake.calls[0]!.body, { items: [{ sku: "beans-house", qty: 2 }] });
  });

  it("passes on the shop's own words when it says no, with the order if there is one", async () => {
    const order = { id: "order_1", payment: "pay_1", cart: "cart_1", board: "AAAA BBBB CCCC DDDD", status: "failed", total: "24.00", currency: "USD", paypal: { orderId: null, captureId: null }, error: "declined" };
    const fake = fakeShop({
      "POST /checkout": () => Response.json({ error: "PayPal didn't take the payment: the capture declined.", order }, { status: 402 }),
      "POST /carts": () => Response.json({ error: 'Bean & Leaf has nothing with the sku "unicorn".' }, { status: 400 }),
    });
    const client = shopClient("http://shop.test", fake.fetcher);
    await assert.rejects(client.checkout({ text: "{}", signature: "s", key: "k" }), (error: unknown) => {
      assert.ok(error instanceof ShopError);
      assert.equal(error.status, 402);
      assert.equal(error.order?.id, "order_1");
      assert.equal(error.message, "The shop didn't take the payment: PayPal didn't take the payment: the capture declined.");
      return true;
    });
    await assert.rejects(client.price([{ sku: "unicorn", qty: 1 }]), /didn't price the cart: Bean & Leaf has nothing with the sku "unicorn"/);
  });

  it("says when the shop can't be reached, and takes only web addresses", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await assert.rejects(shopClient("http://shop.test", down).search("tea"), /couldn't be reached to search its catalog: fetch failed/);
    assert.throws(() => shopClient("file:///etc/passwd"), /http:\/\/ or https:\/\//);
  });
});

describe("a cart from what a step said", () => {
  it("is a list of skus and quantities, on its own or as items", () => {
    assert.deepEqual(cartLines('[{"sku":"beans-house","qty":2},{"sku":"filters"}]'), [
      { sku: "beans-house", qty: 2 },
      { sku: "filters", qty: 1 },
    ]);
    assert.deepEqual(cartLines('{"items":[{"sku":" mug ","qty":1}],"why":"a gift"}'), [{ sku: "mug", qty: 1 }]);
  });

  it("says what's wrong with one that isn't", () => {
    assert.throws(() => cartLines("two bags of beans"), /should be JSON/);
    assert.throws(() => cartLines("[]"), /should list what to buy/);
    assert.throws(() => cartLines('[{"qty":2}]'), /line 1 of the cart needs the product's sku/);
    assert.throws(() => cartLines('[{"sku":"mug","qty":1.5}]'), /whole quantity/);
  });
});
