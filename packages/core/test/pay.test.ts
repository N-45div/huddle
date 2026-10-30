import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import { mock } from "../src/connectors/mock.ts";
import { parseSignable, type Payment, signedBy } from "../src/countersign.ts";
import { Engine, NeedsSignature, PAY_MINUTES } from "../src/engine.ts";
import { parseFlow } from "../src/schema.ts";
import { type CartLine, type PricedCart, type ShopClient, ShopError, type ShopOrder } from "../src/shop.ts";
import { Store } from "../src/store.ts";

const START = Date.parse("2026-10-30T10:00:00Z");
const SHOP = { id: "shop.test", name: "Bean & Leaf" };
const PRICES: Record<string, { name: string; price: string }> = {
  "beans-house": { name: "House blend beans, 1 lb", price: "12.00" },
  filters: { name: "Paper filters, 100", price: "8.50" },
  "gift-200": { name: "Gift card, $200", price: "200.00" },
};

/** A board as the ESP32 makes one. */
function board() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const key = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
  return { key, sign: (text: string) => sign("sha256", Buffer.from(text, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
}

/**
 * A stand-in shop that prices from its own list and, like Bean & Leaf, checks the signature before it "charges".
 * `checkout` can be swapped to say no, or to be unreachable.
 */
function fakeShop(options: { readonly checkout?: (signed: { text: string; signature: string; key: string }, attempt: number) => ShopOrder } = {}) {
  const priced: CartLine[][] = [];
  const checkouts: { text: string; signature: string; key: string }[] = [];
  let carts = 0;
  const client: ShopClient = {
    url: "http://shop.test",
    about: async () => ({ shop: SHOP, currency: "USD", paypal: "sandbox", about: "" }),
    search: async () => ({ shop: SHOP, products: [] }),
    price: async (lines): Promise<PricedCart> => {
      priced.push([...lines]);
      const items = lines.map((line) => {
        const product = PRICES[line.sku];
        if (!product) throw new ShopError(`The shop didn't price the cart: Bean & Leaf has nothing with the sku "${line.sku}".`, 400);
        return { sku: line.sku, name: product.name, qty: line.qty, price: product.price };
      });
      const cents = items.reduce((sum, item) => sum + Math.round(Number(item.price) * 100) * item.qty, 0);
      carts += 1;
      return { id: `cart_${carts}`, shop: SHOP, items, total: (cents / 100).toFixed(2), currency: "USD", expires: "2026-10-30T10:30:00Z" };
    },
    checkout: async (signed) => {
      checkouts.push(signed);
      if (options.checkout) return options.checkout(signed, checkouts.length);
      if (!signedBy(signed.text, signed.signature, signed.key)) throw new ShopError("The shop didn't take the payment: That isn't this board's signature of this payment.", 401);
      const payment = parseSignable(signed.text) as Payment;
      return { id: "order_1", payment: payment.id, cart: payment.cart, board: "AAAA", status: "paid", total: payment.total, currency: payment.currency, paypal: { orderId: "5O190127TN364715T", captureId: "3C679366HH908993F" }, error: null };
    },
    startLink: async () => {
      throw new Error("not used");
    },
    signedLink: async () => {
      throw new Error("not used");
    },
    link: async () => {
      throw new Error("not used");
    },
    board: async () => ({ linked: true, paypal: "buyer@personal.example.com" }),
  };
  return { client, priced, checkouts };
}

const flow = (picked = '{"items":[{"sku":"beans-house","qty":2},{"sku":"filters","qty":1}]}', onNo?: string) =>
  parseFlow({
    name: "Coffee run",
    assistants: [
      { id: "beans", name: "Bean & Leaf", connector: "shop", url: "http://shop.test" },
      { id: "picker", connector: "mock", replies: { "*": picked } },
      { id: "teller", connector: "mock", replies: { "*": "Told them." } },
    ],
    steps: [
      { id: "pick", type: "agent", agent: "picker", ask: "Pick what to buy for: {{input}}" },
      { id: "pay", type: "pay", shop: "beans", cart: "{{pick.data}}", next: "tell", ...(onNo ? { onNo } : {}) },
      { id: "tell", type: "agent", agent: "teller", ask: "Say: {{pay.text}} PayPal order {{pay.data.paypal.orderId}}." },
      { id: "sorry", type: "agent", agent: "teller", ask: "Say nothing was bought." },
    ],
  });

function setUp(shop = fakeShop()) {
  let clock = START;
  const store = new Store();
  const engine = new Engine(store, { mock }, { shops: () => shop.client, now: () => clock });
  const mine = board();
  store.addSigner({ key: mine.key, name: "Desk button", deviceId: "device_1" });
  return { store, engine, shop, mine, tick: (ms: number) => (clock += ms) };
}

describe("a pay step", () => {
  it("has the shop price the cart, and waits for your board to sign exactly what it priced", async () => {
    const { store, engine, shop } = setUp();
    const view = await engine.start(flow(), "coffee for the week");
    assert.equal(view.state, "waiting");
    assert.equal(view.at, "pay");
    assert.equal(view.waiting?.message, "Pay $32.50 to Bean & Leaf: 2× House blend beans, 1 lb; 1× Paper filters, 100");
    assert.deepEqual(shop.priced, [[{ sku: "beans-house", qty: 2 }, { sku: "filters", qty: 1 }]]);
    const [request] = store.waitingSignRequests();
    const payment = parseSignable(request!.text) as Payment;
    assert.deepEqual(payment.shop, SHOP);
    assert.equal(payment.cart, "cart_1");
    assert.equal(payment.total, "32.50");
    assert.equal(payment.expires, new Date(START + PAY_MINUTES * 60_000).toISOString().replace(".000Z", "Z"), "the sooner of the cart's prices and ten minutes");
    assert.equal(store.approval(view.waiting!.id)?.signs, payment.id);
    assert.deepEqual(shop.checkouts, [], "nothing is paid before the board signs");
  });

  it("won't take a yes from the canvas, an assistant or the button's hold: only the board's signature", async () => {
    const { engine } = setUp();
    const view = await engine.start(flow(), "coffee");
    assert.throws(() => engine.answer(view.waiting!.id, true), NeedsSignature);
    await assert.rejects(engine.decide(view.waiting!.id, true), NeedsSignature);
    assert.equal(engine.view(view.id).state, "waiting");
  });

  it("pays once your board signs, and the steps after see what was paid", async () => {
    const { store, engine, shop, mine } = setUp();
    const view = await engine.start(flow(), "coffee");
    const request = store.waitingSignRequests()[0]!;
    const done = await engine.countersign(request.id, mine.sign(request.text), mine.key);
    assert.equal(done.state, "done");
    // The shop is sent exactly the text the board was shown, its key, and a signature of that text by it.
    assert.equal(shop.checkouts.length, 1);
    assert.equal(shop.checkouts[0]!.text, request.text);
    assert.equal(shop.checkouts[0]!.key, mine.key);
    assert.ok(signedBy(request.text, shop.checkouts[0]!.signature, mine.key));
    assert.equal(done.context.steps.pay?.text, "Paid $32.50 to Bean & Leaf with PayPal (order 5O190127TN364715T).");
    assert.deepEqual((done.context.steps.pay?.data as { paypal: unknown }).paypal, { orderId: "5O190127TN364715T", captureId: "3C679366HH908993F" });
    const told = store.logOf(view.id).find((line) => line.kind === "asked" && line.stepId === "tell");
    assert.equal((told?.detail as { ask: string }).ask, "Say: Paid $32.50 to Bean & Leaf with PayPal (order 5O190127TN364715T). PayPal order 5O190127TN364715T.");
    assert.equal(store.signRequest(request.id)?.status, "paid");
    const kinds = store.logOf(view.id).filter((line) => line.stepId === "pay").map((line) => line.kind);
    assert.deepEqual(kinds, ["waiting", "signed", "paid"]);
  });

  it("turns away a signature from a board you haven't added, of another text, or a second time", async () => {
    const { store, engine, mine } = setUp();
    await engine.start(flow(), "coffee");
    const request = store.waitingSignRequests()[0]!;
    const stranger = board();
    await assert.rejects(engine.countersign(request.id, stranger.sign(request.text), stranger.key), /isn't one of your boards'/);
    const other = request.text.replace("32.50", "3.25");
    await assert.rejects(engine.countersign(request.id, mine.sign(other), mine.key), /isn't your board's signature of this payment/);
    await engine.countersign(request.id, mine.sign(request.text), mine.key);
    await assert.rejects(engine.countersign(request.id, mine.sign(request.text), mine.key), /already paid/);
  });

  it("goes to onNo when you say no, from anywhere, and pays nothing", async () => {
    const { store, engine, shop } = setUp();
    const view = await engine.start(flow(undefined, "sorry"), "coffee");
    const request = store.waitingSignRequests()[0]!;
    const after = await engine.decide(view.waiting!.id, false);
    assert.equal(after.state, "done");
    assert.ok(store.logOf(view.id).some((line) => line.stepId === "sorry" && line.kind === "answered"));
    assert.equal(store.signRequest(request.id)?.status, "declined");
    assert.deepEqual(shop.checkouts, []);
    // Without onNo, a no ends the run as declined.
    const second = setUp();
    const declined = await second.engine.start(flow(), "coffee");
    assert.equal((await second.engine.decide(declined.waiting!.id, false)).state, "declined");
  });

  it("fails when the payment expires unsigned, and asks the board again when the run is tried again", async () => {
    const { store, engine, mine, tick } = setUp();
    const view = await engine.start(flow(), "coffee");
    const first = store.waitingSignRequests()[0]!;
    tick((PAY_MINUTES + 1) * 60_000);
    assert.throws(() => engine.sign(first.id, mine.sign(first.text), mine.key), /expired before it was signed/);
    await new Promise((resolve) => setImmediate(resolve));
    const failed = engine.view(view.id);
    assert.equal(failed.state, "failed");
    assert.match(failed.error ?? "", /expired before your board signed it/);
    assert.equal(store.signRequest(first.id)?.status, "expired");
    engine.retry(view.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const again = store.waitingSignRequests();
    assert.equal(again.length, 1);
    assert.notEqual(again[0]!.id, first.id, "a new payment, with a new signature needed");
  });

  it("fails when the shop says no, and needs a new signature to try again", async () => {
    const shop = fakeShop({
      checkout: () => {
        throw new ShopError("The shop didn't take the payment: This board isn't linked to a PayPal at Bean & Leaf. Link it first.", 401);
      },
    });
    const { store, engine, mine } = setUp(shop);
    const view = await engine.start(flow(), "coffee");
    const request = store.waitingSignRequests()[0]!;
    const failed = await engine.countersign(request.id, mine.sign(request.text), mine.key);
    assert.equal(failed.state, "failed");
    assert.match(failed.error ?? "", /isn't linked to a PayPal at Bean & Leaf/);
    assert.equal(store.signRequest(request.id)?.status, "failed");
    assert.equal(failed.id, view.id);
  });

  it("sends the same signed payment again when the shop couldn't be reached, without asking the board", async () => {
    const shop = fakeShop({
      checkout: (signed, attempt) => {
        if (attempt === 1) throw new Error("The shop at http://shop.test couldn't be reached to take the payment: fetch failed");
        const payment = parseSignable(signed.text) as Payment;
        return { id: "order_1", payment: payment.id, cart: payment.cart, board: "AAAA", status: "paid", total: payment.total, currency: "USD", paypal: { orderId: "ORDER", captureId: "CAPTURE" }, error: null };
      },
    });
    const { store, engine, mine } = setUp(shop);
    const view = await engine.start(flow(), "coffee");
    const request = store.waitingSignRequests()[0]!;
    assert.equal((await engine.countersign(request.id, mine.sign(request.text), mine.key)).state, "failed");
    assert.equal(store.signRequest(request.id)?.status, "signed", "still the board's yes, kept for the next try");
    engine.retry(view.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(engine.view(view.id).state, "done");
    assert.equal(shop.checkouts.length, 2);
    assert.equal(shop.checkouts[1]!.text, request.text);
    assert.deepEqual(store.waitingSignRequests(), []);
  });

  it("says plainly what's wrong with a cart it can't buy", async () => {
    const { engine } = setUp();
    const unreadable = await engine.start(flow("I'd get some beans."), "coffee");
    assert.equal(unreadable.state, "failed");
    assert.match(unreadable.error ?? "", /Step "pay" can't buy anything: the cart should be JSON/);
    const unsold = await engine.start(flow('[{"sku":"unicorn","qty":1}]'), "coffee");
    assert.match(unsold.error ?? "", /nothing with the sku "unicorn"/);
  });
});

describe("a flow with a pay step", () => {
  it("buys only at one of its own shops", () => {
    assert.throws(
      () =>
        parseFlow({
          name: "x",
          assistants: [{ id: "picker", connector: "mock" }],
          steps: [{ id: "pay", type: "pay", shop: "picker", cart: "[]" }],
        }),
      /buys at "picker", which isn't a shop/,
    );
    assert.throws(() => parseFlow({ name: "x", steps: [{ id: "pay", type: "pay", shop: "beans", cart: "[]" }] }), /isn't one of the flow's assistants/);
    assert.throws(
      () => parseFlow({ name: "x", assistants: [{ id: "beans", connector: "shop", url: "http://shop.test" }], steps: [{ id: "pay", type: "pay", shop: "beans", cart: "[]", onNo: "nowhere" }] }),
      /goes to "nowhere"/,
    );
  });
});
