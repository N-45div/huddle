import type { Price } from "./cost.ts";

/**
 * Nebius Token Factory (tokenfactory.nebius.com): NVIDIA's open Nemotron models, and others, behind an
 * OpenAI-style chat API, paid per token. Nemotron thinks before it answers unless told not to: asked which
 * assistant should plan a trip, Nemotron 3.5 Lightning took 5.8 s and 1,344 tokens thinking, against 0.4 s
 * and 16 tokens without (Oct 15 2026). So Huddle's own quick calls turn thinking off, and a nebius assistant
 * thinks only when you turn it on.
 */

export const TOKEN_FACTORY_URL = "https://api.tokenfactory.nebius.com/v1";
const CATALOG_URL = "https://tokenfactory.nebius.com/api/public/models_info";

/** NVIDIA's models on Token Factory, by what they're for. */
export const NEMOTRON = {
  /** Fast and cheap, a million tokens of context: routing and everyday answers. */
  lightning: "nvidia/Nemotron-3_5-Lightning",
  /** Most work: writing, filling in views. Nemotron 3.5 Super VL, which reads images and video as well as text. */
  super: "nvidia/Nemotron-3.5-Super-VL",
  /** The hardest reasoning: plans, drafting whole flows. */
  ultra: "nvidia/Nemotron-3-Ultra-550b-a55b",
  /** Reads images and video as well as text. */
  vision: "nvidia/Nemotron-3.5-Super-VL",
} as const;

/**
 * Models Token Factory retired from Serverless on November 9 2026, and what to ask instead: Nebius's own
 * replacement for Nemotron 3 Super, and Lightning, at Nano's price, for Nano. A flow or an assistant saved with
 * one of them is asked its replacement, so it keeps working.
 */
export const RETIRED: Readonly<Record<string, string>> = {
  "nvidia/nemotron-3-super-120b-a12b": NEMOTRON.super,
  "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": NEMOTRON.lightning,
};

/** The model to ask Token Factory for: a retired one's replacement, else the model itself. */
export const currentModel = (model: string): string => RETIRED[model] ?? model;

export const isTokenFactory = (url: string | undefined): boolean => {
  if (!url) return false;
  try {
    return new URL(url).hostname === "api.tokenfactory.nebius.com";
  } catch {
    return false;
  }
};

/** What to add to a chat request so a model on Token Factory thinks first or not; nothing for other APIs. */
export const thinkingFor = (url: string | undefined, thinking: boolean): Record<string, unknown> => (isTokenFactory(url) ? { chat_template_kwargs: { enable_thinking: thinking } } : {});

/** Per million tokens, from Token Factory's public catalog on Oct 15 2026; refreshed from it when Huddle starts. */
const prices = new Map<string, Price>([
  [NEMOTRON.lightning, { input: 0.06, output: 0.24, call: 0 }],
  [NEMOTRON.super, { input: 0.3, output: 0.9, call: 0 }],
  [NEMOTRON.ultra, { input: 1, output: 3, call: 0 }],
]);

/** What a Token Factory model charges, if Huddle knows it: a retired one, what its replacement charges. */
export const tokenFactoryPrice = (model: string | undefined): Price | null => (model ? (prices.get(currentModel(model)) ?? null) : null);

/** Reads every model's current price from Token Factory's public catalog (no key needed); answers how many it read. */
export async function refreshTokenFactoryPrices(fetcher: typeof fetch = globalThis.fetch): Promise<number> {
  const response = await fetcher(CATALOG_URL, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Token Factory's catalog answered HTTP ${response.status}.`);
  const body = (await response.json()) as unknown;
  const models = Array.isArray(body) ? body : [];
  let read = 0;
  for (const model of models as { flavors?: { model_id?: unknown; input_price_per_million_tokens?: unknown; output_price_per_million_tokens?: unknown }[] }[]) {
    for (const flavor of model.flavors ?? []) {
      const { model_id: id, input_price_per_million_tokens: input, output_price_per_million_tokens: output } = flavor;
      if (typeof id === "string" && typeof input === "number" && typeof output === "number" && input >= 0 && output >= 0) {
        prices.set(id, { input, output, call: 0 });
        read++;
      }
    }
  }
  return read;
}

/** The models a Token Factory key can use, NVIDIA's first. */
export async function tokenFactoryModels(key: string | undefined, fetcher: typeof fetch = globalThis.fetch): Promise<string[]> {
  if (!key) throw new Error("Set NEBIUS_API_KEY (or the key variable you named) where Huddle runs: Token Factory lists its models only to a key.");
  const response = await fetcher(`${TOKEN_FACTORY_URL}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
  if (response.status === 401 || response.status === 403) throw new Error("Token Factory didn't accept that key.");
  if (!response.ok) throw new Error(`Token Factory answered HTTP ${response.status}.`);
  const body = (await response.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
  const ids = [...new Set((body?.data ?? []).map((model) => (typeof model.id === "string" ? model.id : "")).filter(Boolean))];
  const nvidia = (id: string) => (id.startsWith("nvidia/") ? 0 : 1);
  return ids.sort((a, b) => nvidia(a) - nvidia(b) || a.localeCompare(b));
}
