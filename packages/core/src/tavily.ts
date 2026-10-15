/**
 * Tavily (tavily.com): web search made for agents, answering with the text of each result that matches the
 * question, not just links. Huddle uses it to look things up for a flow, and to check the facts in what a
 * flow asks you to approve. A basic search costs 1 credit, an advanced one 2 (1,000 free a month, then
 * $0.008 a credit, Oct 2026).
 */

export const TAVILY_API = "https://api.tavily.com";
/** Tavily's pay-as-you-go price for one credit, in US dollars. */
export const TAVILY_CREDIT_USD = 0.008;

export interface TavilyResult {
  readonly title: string;
  readonly url: string;
  /** The parts of the page that match the query. */
  readonly content: string;
  readonly score: number;
}

export interface TavilySearch {
  readonly results: readonly TavilyResult[];
  /** Tavily's own short answer, when asked for. */
  readonly answer: string | null;
  readonly credits: number | null;
}

export interface SearchOptions {
  readonly depth?: "basic" | "advanced";
  readonly maxResults?: number;
  readonly answer?: boolean;
  readonly signal?: AbortSignal;
}

export async function tavilySearch(key: string, query: string, options: SearchOptions = {}, fetcher: typeof fetch = globalThis.fetch): Promise<TavilySearch> {
  const response = await fetcher(`${TAVILY_API}/search`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: query.slice(0, 400),
      search_depth: options.depth ?? "basic",
      max_results: options.maxResults ?? 5,
      chunks_per_source: 3,
      include_answer: options.answer ?? false,
      include_usage: true,
    }),
    signal: options.signal ?? AbortSignal.timeout(30_000),
  });
  const body = (await response.json().catch(() => null)) as {
    results?: { title?: unknown; url?: unknown; content?: unknown; score?: unknown }[];
    answer?: unknown;
    usage?: { credits?: unknown };
    detail?: { error?: unknown } | unknown;
  } | null;
  if (!response.ok) {
    if (response.status === 401) throw new Error("Tavily didn't accept the key.");
    if (response.status === 429) throw new Error("Tavily says too many searches at once; try again in a minute.");
    if (response.status === 432 || response.status === 433) throw new Error("Tavily's credits for this key are used up for the month.");
    const detail = body?.detail as { error?: unknown } | undefined;
    const said = typeof detail?.error === "string" ? detail.error : `HTTP ${response.status}`;
    throw new Error(`Tavily said: ${said.replaceAll(key, "[key]")}`);
  }
  const results = (body?.results ?? [])
    .filter((result) => typeof result.url === "string")
    .map((result) => ({
      title: typeof result.title === "string" ? result.title : String(result.url),
      url: String(result.url),
      content: typeof result.content === "string" ? result.content : "",
      score: typeof result.score === "number" ? result.score : 0,
    }));
  const credits = typeof body?.usage?.credits === "number" ? body.usage.credits : null;
  return { results, answer: typeof body?.answer === "string" && body.answer.trim() ? body.answer : null, credits };
}
