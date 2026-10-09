/**
 * Optional: a reranking model reads the query beside each matching note and orders them by how well
 * they fit, more carefully than word and vector matches can. Voyage, Cohere and Jina all take
 * `{ model, query, documents }` at `/rerank` and answer with each document's index and score.
 */

export interface Reranker {
  readonly model: string;
  /** Indexes into `documents`, best first; throws when the API fails. */
  rank(query: string, documents: readonly string[], timeoutMs: number): Promise<number[]>;
}

export interface RerankerOptions {
  /** The API base (e.g. https://api.voyageai.com/v1) or the full rerank URL. */
  readonly url: string;
  readonly model: string;
  readonly key?: string;
  readonly fetcher?: typeof fetch;
}

export function reranker(options: RerankerOptions): Reranker {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const endpoint = /\/rerank\/?$/.test(options.url) ? options.url : `${options.url.replace(/\/$/, "")}/rerank`;
  return {
    model: options.model,
    async rank(query, documents, timeoutMs) {
      if (documents.length === 0) return [];
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(options.key ? { authorization: `Bearer ${options.key}` } : {}) },
        body: JSON.stringify({ model: options.model, query, documents }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      type Ranked = { index?: unknown; relevance_score?: unknown };
      const body = (await response.json().catch(() => null)) as { data?: Ranked[]; results?: Ranked[]; detail?: unknown; message?: unknown } | null;
      if (!response.ok) {
        const said = typeof body?.detail === "string" ? body.detail : typeof body?.message === "string" ? body.message : `HTTP ${response.status}`;
        throw new Error(`The rerank API said: ${options.key ? said.replaceAll(options.key, "[key]") : said}`);
      }
      const ranked = (body?.data ?? body?.results ?? [])
        .filter((item): item is { index: number; relevance_score: number } => Number.isInteger(item.index) && (item.index as number) >= 0 && (item.index as number) < documents.length && typeof item.relevance_score === "number")
        .sort((a, b) => b.relevance_score - a.relevance_score)
        .map((item) => item.index);
      if (ranked.length === 0) throw new Error("The rerank API didn't rank anything.");
      return [...new Set(ranked)];
    },
  };
}
