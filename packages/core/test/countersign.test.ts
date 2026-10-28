import assert from "node:assert/strict";
import { generateKeyPairSync, sign, webcrypto } from "node:crypto";
import { describe, it } from "node:test";
import {
  amountText,
  boardKey,
  expired,
  fingerprint,
  MAX_ITEMS,
  parseSignable,
  type Payment,
  signableId,
  signableLine,
  signableText,
  signableTime,
  signedBy,
} from "../src/countersign.ts";

const payment: Payment = {
  v: 1,
  kind: "buy",
  id: "pay_0123456789abcdef01234567",
  shop: { id: "beanandleaf.example", name: "Bean & Leaf" },
  cart: "cart_91",
  items: [
    { name: "House blend beans, 1 lb", qty: 2, price: "12.00" },
    { name: "Paper filters", qty: 1, price: "8.50" },
  ],
  total: "32.50",
  currency: "USD",
  expires: "2026-10-29T10:15:00Z",
};

/** A board as the canvas's virtual one makes it: WebCrypto, with the raw public key it sends in hello. */
async function webBoard() {
  const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const raw = Buffer.from(await webcrypto.subtle.exportKey("raw", keys.publicKey)).toString("base64url");
  const signText = async (text: string) => Buffer.from(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, new TextEncoder().encode(text))).toString("base64url");
  return { raw, signText };
}

/** A board as the ESP32 makes it: the raw point, and r and s side by side (mbedTLS gives them as two numbers). */
function chipBoard() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
  const signText = (text: string) => sign("sha256", Buffer.from(text, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return { raw, signText };
}

describe("the text a board signs", () => {
  it("has one way to be written, and reads back to the same payment", () => {
    const text = signableText(payment);
    assert.equal(
      text,
      '{"v":1,"kind":"buy","id":"pay_0123456789abcdef01234567","shop":{"id":"beanandleaf.example","name":"Bean & Leaf"},"cart":"cart_91","items":[{"name":"House blend beans, 1 lb","qty":2,"price":"12.00"},{"name":"Paper filters","qty":1,"price":"8.50"}],"total":"32.50","currency":"USD","expires":"2026-10-29T10:15:00Z"}',
    );
    assert.deepEqual(parseSignable(text), payment);
    // Built with its keys in another order, it's still written the same way.
    const shuffled = { expires: payment.expires, currency: "USD", total: "32.50", items: payment.items, cart: "cart_91", shop: payment.shop, id: payment.id, kind: "buy", v: 1 } as const;
    assert.equal(signableText(shuffled), text);
  });

  it("refuses a text written any other way, so no two readers can see different payments in it", () => {
    const text = signableText(payment);
    assert.throws(() => parseSignable(text.replace('"v":1,', '"v":1, ')), /the one way/);
    assert.throws(() => parseSignable(JSON.stringify({ ...JSON.parse(text), note: "hi" })), /something extra: note/);
    // A second "total" further on: JSON.parse would take the last one, the board might take the first.
    assert.throws(() => parseSignable(text.replace('"currency":"USD"', '"total":"3.25","currency":"USD"')), /the one way|come to/);
    assert.throws(() => parseSignable(text.replace('"qty":2', '"qty":2.5')), /quantity from 1 to 99/);
    assert.throws(() => parseSignable(text.replace('"8.50"', '"8.5"')), /written like 12.00/);
    assert.throws(() => parseSignable(text.replace('"USD"', '"usd"')), /three-letter code/);
    assert.throws(() => parseSignable("not json"), /isn't JSON/);
    assert.throws(() => parseSignable(JSON.stringify({ kind: "send" })), /neither a payment/);
  });

  it("refuses a total its lines don't add up to", () => {
    assert.throws(() => parseSignable(signableText({ ...payment, total: "3.25" })), /lines come to 32.50, not the 3.25/);
  });

  it("keeps the shop's id to a plain host, so a lookalike can't hide in it", () => {
    assert.throws(() => parseSignable(signableText({ ...payment, shop: { id: "beanandleaf.example/../evil", name: "Bean & Leaf" } })), /web address's host/);
    assert.throws(() => parseSignable(signableText({ ...payment, shop: { id: "BeanAndLeaf.example", name: "Bean & Leaf" } })), /web address's host/);
    assert.equal(parseSignable(signableText({ ...payment, shop: { id: "localhost:7700", name: "Bean & Leaf" } })).shop.id, "localhost:7700");
  });

  it("refuses names a screen can't show plainly: control and direction-changing characters", () => {
    assert.throws(() => parseSignable(signableText({ ...payment, items: [{ name: "Gift card‮05.21", qty: 1, price: "32.50" }] })), /can't show plainly/);
    assert.throws(() => parseSignable(signableText({ ...payment, shop: { id: "beanandleaf.example", name: "Bean\nLeaf" } })), /can't show plainly/);
    assert.throws(() => parseSignable(signableText({ ...payment, items: [{ name: " Mug", qty: 1, price: "32.50" }] })), /spaces/);
  });

  it(`has between 1 and ${MAX_ITEMS} lines, and stays small enough for the board`, () => {
    assert.throws(() => parseSignable(signableText({ ...payment, items: [], total: "0.00" })), /between 1 and/);
    const many = Array.from({ length: MAX_ITEMS + 1 }, (_, index) => ({ name: `Thing ${index}`, qty: 1, price: "1.00" }));
    assert.throws(() => parseSignable(signableText({ ...payment, items: many, total: `${MAX_ITEMS + 1}.00` })), /between 1 and/);
    assert.throws(() => parseSignable("x".repeat(2_000)), /at most/);
  });

  it("links a board at a shop with a text of its own", () => {
    const link = { v: 1, kind: "link", id: "link_00112233445566778899aabb", shop: payment.shop, expires: "2026-10-29T10:15:00Z" } as const;
    const text = signableText(link);
    assert.deepEqual(parseSignable(text), link);
    assert.equal(signableLine(link), "Link your PayPal at Bean & Leaf to this board");
  });

  it("says what it asks in one line", () => {
    assert.equal(signableLine(payment), "Pay $32.50 to Bean & Leaf: 2× House blend beans, 1 lb; 1× Paper filters");
    assert.equal(amountText("32.50", "CHF"), "32.50 CHF");
  });

  it("makes one-time ids and times to the second", () => {
    assert.match(signableId("pay"), /^pay_[0-9a-f]{24}$/);
    assert.notEqual(signableId("pay"), signableId("pay"));
    assert.equal(signableTime(Date.parse("2026-10-29T10:15:00.987Z")), "2026-10-29T10:15:00Z");
    assert.equal(expired(payment, Date.parse("2026-10-29T10:14:59Z")), false);
    assert.equal(expired(payment, Date.parse("2026-10-29T10:15:00Z")), true);
  });
});

describe("a board's signature", () => {
  for (const [name, make] of [
    ["the virtual board's (WebCrypto)", webBoard],
    ["the ESP32's (raw r and s)", async () => chipBoard()],
  ] as const) {
    it(`is checked against exactly the text it signed: ${name}`, async () => {
      const board = await make();
      const text = signableText(payment);
      const signature = await board.signText(text);
      assert.equal(signedBy(text, signature, board.raw), true);
      // One cent more, or another shop, and it's not what was signed.
      assert.equal(signedBy(signableText({ ...payment, total: "32.51", items: [...payment.items.slice(0, 1), { name: "Paper filters", qty: 1, price: "8.51" }] }), signature, board.raw), false);
      assert.equal(signedBy(signableText({ ...payment, shop: { id: "bean-and-leaf.example", name: "Bean & Leaf" } }), signature, board.raw), false);
      // Another board's key doesn't vouch for it.
      assert.equal(signedBy(text, signature, chipBoard().raw), false);
    });
  }

  it("is false for anything that isn't one, never an error", () => {
    const board = chipBoard();
    const text = signableText(payment);
    assert.equal(signedBy(text, "", board.raw), false);
    assert.equal(signedBy(text, "a".repeat(86), board.raw), false);
    assert.equal(signedBy(text, board.signText(text), "not-a-key"), false);
    assert.equal(signedBy(text, sign("sha256", Buffer.from(text), generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey).toString("base64url"), board.raw), false, "a DER signature isn't taken");
  });

  it("comes from a key that's a real P-256 point, with a fingerprint both screens can show", () => {
    const board = chipBoard();
    assert.equal(boardKey(board.raw).asymmetricKeyType, "ec");
    assert.match(fingerprint(board.raw), /^[0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4}$/);
    assert.equal(fingerprint(board.raw), fingerprint(board.raw));
    assert.notEqual(fingerprint(board.raw), fingerprint(chipBoard().raw));
    assert.throws(() => boardKey(Buffer.alloc(65, 4).toString("base64url")), /isn't a point on P-256/);
    assert.throws(() => boardKey(Buffer.alloc(33, 2).toString("base64url")), /uncompressed/);
  });
});
