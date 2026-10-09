/**
 * Optional: notes found by meaning as well as by their words. Any OpenAI-compatible embeddings API
 * works (OpenAI, Voyage, Ollama, LM Studio, OpenRouter). Vectors are kept beside the notes as BLOBs
 * and compared here, so nothing beyond SQLite is needed.
 */

export interface Embedder {
  /** The model's name: vectors from another model are never compared with its own. */
  readonly model: string;
  /** One vector per text, in order; throws when the API fails. */
  embed(texts: readonly string[], timeoutMs: number): Promise<Float32Array[]>;
}

export interface EmbedderOptions {
  /** The API base (e.g. https://api.openai.com/v1) or the full embeddings URL. */
  readonly url: string;
  readonly model: string;
  readonly key?: string;
  readonly fetcher?: typeof fetch;
}

export function embedder(options: EmbedderOptions): Embedder {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const endpoint = /\/embeddings\/?$/.test(options.url) ? options.url : `${options.url.replace(/\/$/, "")}/embeddings`;
  return {
    model: options.model,
    async embed(texts, timeoutMs) {
      if (texts.length === 0) return [];
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(options.key ? { authorization: `Bearer ${options.key}` } : {}) },
        body: JSON.stringify({ model: options.model, input: texts }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = (await response.json().catch(() => null)) as { data?: { index?: unknown; embedding?: unknown }[]; error?: { message?: string } | string } | null;
      if (!response.ok) {
        const said = (typeof body?.error === "string" ? body.error : body?.error?.message) ?? `HTTP ${response.status}`;
        throw new Error(`The embeddings API said: ${options.key ? said.replaceAll(options.key, "[key]") : said}`);
      }
      const vectors: Float32Array[] = [];
      for (const [position, item] of (body?.data ?? []).entries()) {
        const index = typeof item.index === "number" ? item.index : position;
        if (Array.isArray(item.embedding) && item.embedding.every((value) => typeof value === "number")) vectors[index] = Float32Array.from(item.embedding as number[]);
      }
      const size = vectors[0]?.length ?? 0;
      if (size === 0 || texts.some((_, index) => vectors[index]?.length !== size)) throw new Error("The embeddings API didn't send a vector for every text.");
      return vectors;
    },
  };
}

/** Cosine similarity; 0 for vectors of different sizes (another model's). */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index]!;
    const y = b[index]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

export function toBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function fromBlob(blob: Uint8Array): Float32Array {
  // A copy, so the floats are aligned whatever SQLite's buffer is.
  return new Float32Array(Uint8Array.from(blob).buffer);
}
