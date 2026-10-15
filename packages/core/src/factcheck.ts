import { TAVILY_CREDIT_USD, type TavilyResult, tavilySearch } from "./tavily.ts";
import { isTokenFactory, thinkingFor, tokenFactoryPrice } from "./tokenfactory.ts";

/**
 * Checking the facts in what a flow asks you to approve, before you say yes. A quick model lists the facts
 * in the message that the web can settle (times, prices, train numbers, opening hours, rules); Tavily
 * searches each one; a stronger model says whether the sources back it, quoting them. A quote that isn't
 * word for word in the source it names doesn't count: that fact is marked unclear, so a model can't make
 * evidence up. What you approve is still up to you; this shows you what the web says first.
 */

export type Verdict = "supported" | "contradicted" | "unclear";

export interface CheckedFact {
  readonly claim: string;
  readonly verdict: Verdict;
  /** One plain line on why. */
  readonly note: string;
  /** The source that settles it, with the words that show it; null when nothing settles it. */
  readonly source: { readonly title: string; readonly url: string; readonly quote: string } | null;
}

export interface FactCheck {
  readonly facts: readonly CheckedFact[];
  /** The model that weighed the sources, "with Tavily". */
  readonly checkedBy: string;
  /** What the check cost: Tavily's credits, plus the models where their price is known. */
  readonly costUsd: number;
}

export type FactChecker = (text: string) => Promise<FactCheck>;

export interface ChatModel {
  /** An OpenAI-compatible API base. */
  readonly url: string;
  readonly model: string;
  readonly key?: string;
}

export interface FactCheckOptions {
  readonly tavilyKey: string;
  /** Lists the facts worth checking: a quick model does. */
  readonly lister: ChatModel;
  /** Weighs the sources: a stronger one. */
  readonly judge: ChatModel;
  /** The most facts one check looks up (default 5; each is an advanced search, 2 Tavily credits). */
  readonly maxFacts?: number;
  readonly fetcher?: typeof fetch;
}

const LIST = (max: number) =>
  `Someone is about to approve the message below. List the facts in it that the public web can confirm or refute and that matter to their decision: facts about a specific, named thing, such as a train or flight's number and times, a place or attraction's entry fee or opening hours, a business's address, a rule or limit. Leave out the message's own estimates and totals (what a hotel or a meal "costs" without naming one), plans, opinions, and anything about the person themselves. Up to ${max}, each a short statement that stands on its own (name what it's about). Answer with JSON only: {"facts": ["...", ...]}`;

const JUDGE = `You check facts against web sources, using only the sources given. For each fact: "supported" if a source says the same thing about the same specific thing, "contradicted" if a source about that same thing says otherwise, "unclear" if the sources don't settle it. A matching number about something else (another hotel, another route, someone's own deal) settles nothing. For supported or contradicted, give the source's number and a quote copied word for word from that source's text, under 30 words, that shows it. Answer with JSON only: {"verdicts": [{"fact": <number>, "verdict": "supported" | "contradicted" | "unclear", "source": <number or null>, "quote": "<exact words, or empty>", "note": "<one short line in plain words>"}]}`;

/** Text compared loosely: case, spacing, curly quotes and dashes don't matter. */
const loose = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

/** Whether a quote really is in the source: word for word, give or take case, spacing and punctuation style. */
export function quoted(quote: string, content: string): boolean {
  const words = loose(quote).replace(/^["'.…\s]+|["'.…\s]+$/g, "");
  return words.length >= 8 && loose(content).includes(words);
}

async function askJson(model: ChatModel, system: string, user: string, fetcher: typeof fetch): Promise<{ json: unknown; costUsd: number }> {
  const endpoint = `${model.url.replace(/\/+$/, "")}/chat/completions`;
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...(model.key ? { authorization: `Bearer ${model.key}` } : {}) },
    body: JSON.stringify({ model: model.model, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: user }], ...thinkingFor(model.url, false) }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await response.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }; error?: { message?: string } } | null;
  if (!response.ok) {
    const said = body?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`The checking model said: ${model.key ? said.replaceAll(model.key, "[key]") : said}`);
  }
  const content = String(body?.choices?.[0]?.message?.content ?? "");
  const found = /\{[\s\S]*\}/.exec(content)?.[0];
  let json: unknown = null;
  try {
    json = JSON.parse(found ?? "null");
  } catch {
    json = null;
  }
  const price = isTokenFactory(model.url) ? tokenFactoryPrice(model.model) : null;
  const tokensIn = typeof body?.usage?.prompt_tokens === "number" ? body.usage.prompt_tokens : 0;
  const tokensOut = typeof body?.usage?.completion_tokens === "number" ? body.usage.completion_tokens : 0;
  return { json, costUsd: price ? (tokensIn * price.input + tokensOut * price.output) / 1_000_000 : 0 };
}

export function factChecker(options: FactCheckOptions): FactChecker {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const max = options.maxFacts ?? 5;
  return async (text) => {
    let costUsd = 0;
    const listed = await askJson(options.lister, LIST(max), text.slice(0, 8_000), fetcher);
    costUsd += listed.costUsd;
    const raw = (listed.json as { facts?: unknown } | null)?.facts;
    const claims = (Array.isArray(raw) ? raw : []).filter((claim): claim is string => typeof claim === "string" && claim.trim().length > 0).map((claim) => claim.trim().slice(0, 300)).slice(0, max);
    const checkedBy = `${options.judge.model} with Tavily`;
    if (claims.length === 0) return { facts: [], checkedBy, costUsd };

    // Every fact searched at once; one failing search leaves that fact unclear, not the whole check.
    const searches = await Promise.all(
      claims.map((claim) =>
        tavilySearch(options.tavilyKey, claim, { depth: "advanced", maxResults: 3 }, fetcher).then(
          (found) => ({ results: found.results, credits: found.credits ?? 2, error: null as string | null }),
          (error: unknown) => ({ results: [] as TavilyResult[], credits: 0, error: error instanceof Error ? error.message : String(error) }),
        ),
      ),
    );
    costUsd += searches.reduce((sum, search) => sum + search.credits, 0) * TAVILY_CREDIT_USD;
    const failed = searches.find((search) => search.error)?.error;
    if (failed && searches.every((search) => search.error)) throw new Error(failed);

    const evidence = claims
      .map((claim, index) => {
        const sources = searches[index]!.results.map((result, n) => `[${n + 1}] ${result.title} (${result.url})\n${result.content.slice(0, 2_000)}`).join("\n\n");
        return `Fact ${index + 1}: ${claim}\nSources:\n${sources || "(none found)"}`;
      })
      .join("\n\n---\n\n");
    const judged = await askJson(options.judge, JUDGE, evidence, fetcher);
    costUsd += judged.costUsd;
    const verdicts = (judged.json as { verdicts?: unknown } | null)?.verdicts;

    const facts = claims.map((claim, index): CheckedFact => {
      const search = searches[index]!;
      if (search.error) return { claim, verdict: "unclear", note: `Couldn't search for it: ${search.error}`, source: null };
      const said = (Array.isArray(verdicts) ? verdicts : []).find((verdict) => (verdict as { fact?: unknown })?.fact === index + 1) as
        | { verdict?: unknown; source?: unknown; quote?: unknown; note?: unknown }
        | undefined;
      const verdict: Verdict = said?.verdict === "supported" || said?.verdict === "contradicted" ? said.verdict : "unclear";
      const note = typeof said?.note === "string" && said.note.trim() ? said.note.trim().slice(0, 300) : "The sources found don't settle it.";
      if (verdict === "unclear") return { claim, verdict, note, source: null };
      const result = typeof said?.source === "number" ? search.results[said.source - 1] : undefined;
      const quote = typeof said?.quote === "string" ? said.quote.trim() : "";
      // The check that keeps this honest: the quote must really be in the source it names.
      if (!result || !quoted(quote, result.content)) return { claim, verdict: "unclear", note: "The quote given as evidence isn't in the source, so this isn't settled.", source: null };
      return { claim, verdict, note, source: { title: result.title, url: result.url, quote: quote.slice(0, 400) } };
    });
    return { facts, checkedBy, costUsd };
  };
}
