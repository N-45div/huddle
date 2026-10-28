import { readFileSync } from "node:fs";
import { cents, decimal } from "@huddle/core";

/** What the shop sells, from its catalog file: each product's sku, name, price (for one) and the words it's found by. */

export interface Product {
  readonly sku: string;
  readonly name: string;
  /** For one, in the shop's currency ("12.00"). */
  readonly price: string;
  readonly tags: readonly string[];
}

export interface Catalog {
  readonly name: string;
  readonly about: string;
  readonly currency: string;
  readonly products: readonly Product[];
}

const SKU = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** A catalog from parsed JSON, checked; throws with what's wrong. */
export function parseCatalog(value: unknown): Catalog {
  const record = (value ?? {}) as Record<string, unknown>;
  if (typeof record.name !== "string" || !record.name.trim() || record.name.length > 40) throw new Error("The catalog needs the shop's name (up to 40 characters).");
  if (typeof record.currency !== "string" || !/^[A-Z]{3}$/.test(record.currency)) throw new Error("The catalog needs its currency, like USD.");
  if (!Array.isArray(record.products) || record.products.length === 0) throw new Error("The catalog has no products.");
  const seen = new Set<string>();
  const products = record.products.map((raw, index): Product => {
    const product = (raw ?? {}) as Record<string, unknown>;
    if (typeof product.sku !== "string" || !SKU.test(product.sku)) throw new Error(`Product ${index + 1} needs a sku of lowercase letters, numbers and -.`);
    if (seen.has(product.sku)) throw new Error(`Two products have the sku "${product.sku}".`);
    seen.add(product.sku);
    if (typeof product.name !== "string" || !product.name.trim() || product.name.length > 60) throw new Error(`"${product.sku}" needs a name of up to 60 characters.`);
    const price = typeof product.price === "string" ? cents(product.price) : null;
    if (price === null || price === 0) throw new Error(`"${product.sku}" needs a price, like "12.00".`);
    const tags = Array.isArray(product.tags) ? product.tags.filter((tag): tag is string => typeof tag === "string") : [];
    return { sku: product.sku, name: product.name.trim(), price: decimal(price), tags };
  });
  return { name: record.name.trim(), about: typeof record.about === "string" ? record.about : "", currency: record.currency, products };
}

export function readCatalog(path: string | URL): Catalog {
  return parseCatalog(JSON.parse(readFileSync(path, "utf8")));
}

/** Words that say nothing about what's wanted. */
const FILLER = new Set(
  "a an and any are as at be buy can for from get give help i in is it me my need of on or order our please some something that the this to us want we with you".split(" "),
);
const words = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1 && !FILLER.has(word));

/**
 * The products that fit what's asked for, best first: each of the ask's words found in a product's name, tags
 * or sku counts once (a word's plural or singular counts too). Everything, in catalog order, when nothing's asked.
 */
export function search(catalog: Catalog, ask: string, limit = 8): Product[] {
  const wanted = [...new Set(words(ask))];
  if (!wanted.length) return catalog.products.slice(0, limit);
  const scored = catalog.products.map((product, index) => {
    const own = new Set(words(`${product.name} ${product.tags.join(" ")} ${product.sku}`));
    const score = wanted.filter((word) => own.has(word) || own.has(word.replace(/e?s$/, "")) || own.has(`${word}s`)).length;
    return { product, score, index };
  });
  return scored
    .filter((one) => one.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((one) => one.product);
}
