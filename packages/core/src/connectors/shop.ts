import type { Connector } from "../connector.ts";
import { amountText } from "../countersign.ts";
import { shopClient } from "../shop.ts";

/**
 * A shop that sells to agents, as an assistant: the step's request is what to look for, and the answer is what
 * the shop has that fits, one line each with its sku and price, for the next step to pick from. The products
 * are in the data too. Searching costs nothing and buys nothing: buying is a pay step, which waits for your
 * board's signature. Memory isn't sent: a shop's catalog doesn't need to know you.
 */
export function shop(fetcher: typeof fetch = globalThis.fetch): Connector {
  return {
    async send({ assistant, ask }) {
      if (!assistant.url) throw new Error(`Assistant "${assistant.id}" is a shop: give its address (url).`);
      const found = await shopClient(assistant.url, fetcher).search(ask);
      if (!found.products.length) return { text: `${found.shop.name} has nothing for "${ask.slice(0, 120)}".`, data: { shop: found.shop, products: [] } };
      const lines = found.products.map((product) => `- ${product.sku}: ${product.name}, ${amountText(product.price, product.currency)}`);
      return { text: `${found.shop.name} (${found.shop.id}) has:\n${lines.join("\n")}`, data: { shop: found.shop, products: found.products } };
    },
  };
}
