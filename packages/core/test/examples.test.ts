import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import type { Connector } from "../src/connector.ts";
import { parseSignable, type Payment } from "../src/countersign.ts";
import { Engine } from "../src/engine.ts";
import { parseFlow } from "../src/schema.ts";
import type { ShopClient } from "../src/shop.ts";
import { Store } from "../src/store.ts";

/**
 * Every flow in examples/ runs end to end: each assistant is a stand-in that answers with JSON the flows'
 * conditions and templates read, every approval is answered yes, and every payment is signed by a board at a
 * stand-in shop, so the whole path is walked.
 */

const folder = new URL("../../../examples/", import.meta.url);
const files = readdirSync(folder).filter((name) => name.endsWith(".json"));
const answer = JSON.stringify({ important: true, why: "it's from your landlord", summary: "Rent goes up in March.", focus: ["ship v0.2.0", "call mum", "gym"], options: ["A", "B"], pick: "A", items: ["standup"], total: 450, vendor: "Northwind", amount: 450, cart: [{ sku: "beans-house", qty: 2 }] });

/** A shop that prices anything at $1.00 and takes any payment it's sent. */
const SHOP = { id: "shop.test", name: "Bean & Leaf" };
const shop: ShopClient = {
  url: "http://shop.test",
  about: async () => ({ shop: SHOP, currency: "USD", paypal: "sandbox", about: "" }),
  search: async () => ({ shop: SHOP, products: [] }),
  price: async (lines) => ({ id: "cart_1", shop: SHOP, items: lines.map((line) => ({ sku: line.sku, name: line.sku, qty: line.qty, price: "1.00" })), total: lines.reduce((sum, line) => sum + line.qty, 0).toFixed(2), currency: "USD", expires: "2099-01-01T00:00:00Z" }),
  checkout: async ({ text }) => {
    const payment = parseSignable(text) as Payment;
    return { id: "order_1", payment: payment.id, cart: payment.cart, board: "", status: "paid", total: payment.total, currency: "USD", paypal: { orderId: "ORDER", captureId: "CAPTURE" }, error: null };
  },
  startLink: async () => ({ id: "", text: "", expires: "" }),
  signedLink: async () => ({ approveUrl: "" }),
  link: async () => ({ id: "", status: "", paypal: null, error: null }),
  board: async () => ({ linked: true, paypal: null }),
};
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" });
const boardKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");

describe("the example flows", () => {
  it("are all here", () => {
    assert.ok(files.length >= 5, files.join(", "));
  });

  for (const file of files) {
    it(`${file} runs end to end`, async () => {
      const flow = parseFlow(JSON.parse(readFileSync(new URL(file, folder), "utf8")));
      const asked: string[] = [];
      const standIn: Connector = {
        async send({ assistant, ask }) {
          asked.push(`${assistant.id}: ${ask.slice(0, 40)}`);
          assert.ok(!/\{\{/.test(ask), `${assistant.id} was asked with an unfilled template: ${ask}`);
          return { text: answer, data: JSON.parse(answer) };
        },
      };
      const connectors = Object.fromEntries(flow.assistants.map((assistant) => [assistant.connector, standIn]));
      const store = new Store();
      store.addSigner({ key: boardKey, name: "Test board" });
      const engine = new Engine(store, connectors, { shops: () => shop });
      let view = await engine.start(flow, "Should I take the job in Pune?");
      for (let guard = 0; view.state === "waiting" && guard < 10; guard++) {
        const payment = view.waiting!.signs ? store.signRequest(view.waiting!.signs) : null;
        view = payment
          ? await engine.countersign(payment.id, sign("sha256", Buffer.from(payment.text), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url"), boardKey)
          : await engine.decide(view.waiting!.id, true);
      }
      assert.equal(view.state, "done", `${file}: ${view.error ?? view.state}`);
      assert.ok(asked.length > 0);
    });
  }
});
