import type { DatabaseSync } from "node:sqlite";
import { memoryText } from "../connector.ts";
import type { Note, Store } from "../store.ts";
import { cosine, type Embedder, fromBlob, toBlob } from "./embeddings.ts";
import type { Reranker } from "./rerank.ts";

/**
 * Searching shared memory, and picking what each assistant gets: Sochen's memory engine (its
 * lib/memory/store.ts and provider.ts), ported from Postgres to the store's SQLite file.
 *
 * A note is found by its words, each weighted by how rare it is among the notes searched (BM25's idf,
 * without its length scaling, which cost Sochen points on its benchmark), and, with an embeddings
 * model set up, by meaning too; the two lists are fused by rank. An assistant gets every kept note in
 * its slices while they fit the budget, and past that the ones that match its request first.
 *
 * Memory is an aid: when an outside API fails, search carries on without it, and a run never fails for it.
 */

/** Characters of notes an assistant gets with each request (Sochen's recall budget). */
export const RECALL_BUDGET = 4_000;
/** How much of a note is searched and sent: Sochen keeps 1,200 characters (at 400, late details went missing). */
export const NOTE_CLIP = 1_200;
/** Notes ranked against the request when the slices hold more than the budget. */
const MATCHED = 20;
/** Candidates each search (words, meaning) brings to the fusion. */
const CANDIDATES = 30;
/** Reciprocal Rank Fusion's k. */
const RRF_K = 60;
/** Cosine similarity below this is mostly noise (tuned on voyage-4-lite: unrelated short texts score 0.3 to 0.5). */
const MIN_SIMILARITY = 0.45;
/** Notes given a vector per search; the rest are found by their words until a later search. */
const EMBED_BATCH = 64;
/** How many candidates a reranker reads, and how much of each. */
const RERANK_CANDIDATES = 40;
const RERANK_CHARACTERS = 1_500;
/** After an outside API fails it's left alone this long, so a dead one doesn't slow every run. */
const COOL_DOWN_MS = 60_000;

/**
 * Postgres' English stop words, which Sochen's search leaves out of a query: they're in nearly every
 * note, so they'd only add noise.
 */
const STOP_WORDS = new Set(
  ("i me my myself we our ours ourselves you your yours yourself yourselves he him his himself she her hers herself it its itself " +
    "they them their theirs themselves what which who whom this that these those am is are was were be been being have has had " +
    "having do does did doing a an the and but if or because as until while of at by for with about against between into through " +
    "during before after above below to from up down in out on off over under again further then once here there when where why how " +
    "all any both each few more most other some such no nor not only own same so than too very s t can will just don should now").split(" "),
);

export interface MemoryOptions {
  /** Characters of notes per request (default RECALL_BUDGET). */
  readonly budget?: number;
  /** Finds notes by meaning as well as by their words. */
  readonly embedder?: Embedder | null;
  /** Orders the notes a search finds by how well they fit. */
  readonly reranker?: Reranker | null;
}

export interface MemoryHit {
  readonly note: Note;
  /** The fused rank's score; higher is better. */
  readonly score: number;
  /**
   * For a word match: the idf weight of the query's words the note holds, and that weight's share of
   * the whole query's. Null when only its meaning matched.
   */
  readonly match: { readonly weight: number; readonly share: number } | null;
}

type Candidate = Pick<MemoryHit, "match"> & { readonly id: string };
type Row = Record<string, unknown>;

/** Text on one line, cut to `maxCharacters` with an ellipsis. */
function clip(text: string, maxCharacters: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > maxCharacters ? `${flat.slice(0, maxCharacters - 1).trimEnd()}…` : flat;
}

/**
 * The distinct words of a query, lowercased (24 at most). Marks (\p{M}) belong to words: Hindi, Tamil
 * and other Indian scripts write vowels as marks, and without them "किताब" would split into "क", "त", "ब".
 */
function queryWords(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((word) => word.length > 1 && word !== "or" && word !== "and" && word !== "not");
  return [...new Set(words)].slice(0, 24);
}

export class Memory {
  readonly store: Store;
  readonly budget: number;
  readonly embedder: Embedder | null;
  readonly reranker: Reranker | null;
  /** Whether SQLite's full-text index is here (null until first used). */
  private wordIndex: boolean | null = null;
  private readonly downUntil = new Map<string, number>();

  constructor(store: Store, options: MemoryOptions = {}) {
    this.store = store;
    this.budget = options.budget ?? RECALL_BUDGET;
    this.embedder = options.embedder ?? null;
    this.reranker = options.reranker ?? null;
  }

  private get db(): DatabaseSync {
    return this.store.db;
  }

  /**
   * What an assistant that reads `slices` gets with `ask`: kept notes from those slices and no others,
   * each clipped to NOTE_CLIP. All of them while they fit the budget; past that, the ones that match the
   * ask (best first), then the newest, until the budget is used. If search fails, the newest go first.
   */
  async recall(ask: string, slices: readonly string[]): Promise<Note[]> {
    const notes = this.store.keptNotes(slices).map((note) => (note.note.length > NOTE_CLIP ? { ...note, note: clip(note.note, NOTE_CLIP) } : note));
    const size = (note: Note) => memoryText([note]).length;
    if (notes.reduce((sum, note) => sum + size(note), 0) <= this.budget) return notes;

    let rank = new Map<string, number>();
    if (ask.trim()) {
      try {
        const hits = await this.rank(ask, new Map(notes.map((note) => [note.id, note])), MATCHED);
        rank = new Map(hits.map((hit, index) => [hit.note.id, index]));
      } catch (error) {
        console.warn("[huddle] memory: search failed, so the newest notes go first:", error instanceof Error ? error.message : String(error));
      }
    }
    // A note too long for what's left is skipped, and a shorter one after it may still fit.
    const order = [...notes].reverse().sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
    const chosen = new Set<string>();
    let used = 0;
    for (const note of order) {
      if (used + size(note) > this.budget) continue;
      used += size(note);
      chosen.add(note.id);
    }
    // In the order they were written, as before.
    return notes.filter((note) => chosen.has(note.id));
  }

  /** Notes matching `query`, best first, among those in `slices` (all when not given) with `status` (any when not given). */
  async search(query: string, options: { readonly slices?: readonly string[]; readonly status?: Note["status"]; readonly limit?: number } = {}): Promise<MemoryHit[]> {
    const pool = this.store.notes(options.status).filter((note) => !options.slices || options.slices.includes(note.slice));
    return this.rank(query, new Map(pool.map((note) => [note.id, note])), options.limit ?? 6);
  }

  /** Ranks the notes in `pool` (and only those) against `query`. */
  private async rank(query: string, pool: ReadonlyMap<string, Note>, limit: number): Promise<MemoryHit[]> {
    this.sync();
    const text = this.wordCandidates(query, pool);
    const vector = await this.vectorCandidates(query, pool);
    // Reciprocal Rank Fusion. A note both searches found keeps the word match, which says how well it matched.
    // Kept notes are curated, so like Sochen's memories (and unlike its chat notes) they don't fade with age.
    const fused = new Map<string, { candidate: Candidate; score: number }>();
    for (const list of [text, vector]) {
      list.forEach((candidate, rank) => {
        const current = fused.get(candidate.id);
        fused.set(candidate.id, { candidate: current?.candidate ?? candidate, score: (current?.score ?? 0) + 1 / (RRF_K + rank + 1) });
      });
    }
    const hits = [...fused.values()]
      .sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id))
      .map(({ candidate, score }) => ({ note: pool.get(candidate.id)!, score, match: candidate.match }));
    return (await this.rerank(query, hits)).slice(0, limit);
  }

  /** Makes memory's own tables in the store's file the first time they're needed. */
  private hasWordIndex(): boolean {
    if (this.wordIndex === null) {
      this.db.exec("CREATE TABLE IF NOT EXISTS memory_vectors (id TEXT PRIMARY KEY, model TEXT NOT NULL, vector BLOB NOT NULL)");
      try {
        // Porter stemming, so "invoices" finds "invoice"; marks stay in words, as in queryWords.
        this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_text USING fts5(id UNINDEXED, note, tokenize = "porter unicode61 remove_diacritics 2 categories 'L* N* Co M*'")`);
        this.wordIndex = true;
      } catch (error) {
        console.warn("[huddle] memory: this SQLite has no full-text search (FTS5), so notes are found by meaning only, if at all:", error instanceof Error ? error.message : String(error));
        this.wordIndex = false;
      }
    }
    return this.wordIndex;
  }

  /** Brings the indexes up to date. Notes never change once written (keeping one only flips its status), so this adds new ones and drops forgotten ones. */
  private sync(): void {
    if (!this.hasWordIndex()) {
      this.db.exec("DELETE FROM memory_vectors WHERE id NOT IN (SELECT id FROM notes)");
      return;
    }
    this.db.exec("DELETE FROM memory_text WHERE id NOT IN (SELECT id FROM notes); DELETE FROM memory_vectors WHERE id NOT IN (SELECT id FROM notes)");
    const missing = this.db.prepare("SELECT id, note FROM notes WHERE id NOT IN (SELECT id FROM memory_text)").all() as Row[];
    if (missing.length === 0) return;
    const insert = this.db.prepare("INSERT INTO memory_text (id, note) VALUES (?, ?)");
    this.db.exec("BEGIN");
    try {
      for (const row of missing) insert.run(String(row.id), clip(String(row.note), NOTE_CLIP));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Notes holding the query's words, by the idf of the words each holds (each word counted once), then
   * by how often they appear (Postgres' ts_rank_cd for Sochen's OR query counts just that), then newest.
   */
  private wordCandidates(query: string, pool: ReadonlyMap<string, Note>): Candidate[] {
    if (!this.hasWordIndex()) return [];
    const words = queryWords(query).filter((word) => !STOP_WORDS.has(word));
    if (words.length === 0) return [];
    const find = this.db.prepare(
      "SELECT id, length(highlight(memory_text, 1, char(1), '')) - length(replace(highlight(memory_text, 1, char(1), ''), char(1), '')) AS hits FROM memory_text WHERE memory_text MATCH ?",
    );
    const found = new Map<string, { weight: number; hits: number }>();
    let total = 0;
    for (const word of words) {
      const rows = (find.all(`"${word.replaceAll('"', '""')}"`) as Row[]).filter((row) => pool.has(String(row.id)));
      // How telling the word is among the notes searched (BM25's idf): a name in half of them counts
      // for little, the one word that pins a note down for a lot.
      const idf = Math.log(1 + (pool.size - rows.length + 0.5) / (rows.length + 0.5));
      total += idf;
      for (const row of rows) {
        const id = String(row.id);
        const current = found.get(id) ?? { weight: 0, hits: 0 };
        found.set(id, { weight: current.weight + idf, hits: current.hits + Number(row.hits) });
      }
    }
    const newer = (a: string, b: string) => pool.get(b)!.createdAt.localeCompare(pool.get(a)!.createdAt);
    return [...found]
      .sort(([a, x], [b, y]) => y.weight - x.weight || y.hits - x.hits || newer(a, b) || a.localeCompare(b))
      .slice(0, CANDIDATES)
      .map(([id, { weight }]) => ({ id, match: { weight, share: total > 0 ? weight / total : 0 } }));
  }

  /** Notes close in meaning to the query, when an embeddings model is set up; notes without a vector get one first. */
  private async vectorCandidates(query: string, pool: ReadonlyMap<string, Note>): Promise<Candidate[]> {
    const embedder = this.embedder;
    if (!embedder || !query.trim() || this.cooling("embeddings")) return [];
    const vectors = new Map((this.db.prepare("SELECT id, vector FROM memory_vectors WHERE model = ?").all(embedder.model) as Row[]).map((row) => [String(row.id), fromBlob(row.vector as Uint8Array)]));
    const missing = [...pool.values()].filter((note) => !vectors.has(note.id)).reverse().slice(0, EMBED_BATCH);
    const [added, asked] = await Promise.all([
      missing.length === 0 ? [] : this.softly("embeddings", () => embedder.embed(missing.map((note) => clip(note.note, NOTE_CLIP)), 10_000), []),
      this.softly("embeddings", async () => (await embedder.embed([query], 3_000))[0] ?? null, null),
    ]);
    const keep = this.db.prepare("INSERT OR REPLACE INTO memory_vectors (id, model, vector) VALUES (?, ?, ?)");
    added.forEach((vector, index) => {
      const note = missing[index];
      if (!note) return;
      keep.run(note.id, embedder.model, toBlob(vector));
      vectors.set(note.id, vector);
    });
    if (!asked) return [];
    return [...vectors]
      .filter(([id]) => pool.has(id))
      .map(([id, vector]) => ({ id, similarity: cosine(asked, vector) }))
      .filter((scored) => scored.similarity >= MIN_SIMILARITY)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, CANDIDATES)
      .map(({ id }) => ({ id, match: null }));
  }

  /** The reranker's order of the best candidates, when one is set up; the fused order if it fails. */
  private async rerank(query: string, hits: MemoryHit[]): Promise<MemoryHit[]> {
    const reranker = this.reranker;
    if (!reranker || hits.length < 2 || !query.trim()) return hits;
    const read = hits.slice(0, RERANK_CANDIDATES);
    const order = await this.softly("rerank", () => reranker.rank(query, read.map((hit) => clip(hit.note.note, RERANK_CHARACTERS)), 5_000), null);
    if (!order) return hits;
    const placed = new Set(order);
    return [...order.map((index) => read[index]!), ...read.filter((_, index) => !placed.has(index)), ...hits.slice(RERANK_CANDIDATES)];
  }

  private cooling(service: string): boolean {
    return (this.downUntil.get(service) ?? 0) > Date.now();
  }

  /** Runs an outside call; if it fails, says so, leaves that API alone for a while and goes on with `fallback`. */
  private async softly<T>(service: string, work: () => Promise<T>, fallback: T): Promise<T> {
    if (this.cooling(service)) return fallback;
    try {
      return await work();
    } catch (error) {
      // Calls made side by side fail together; say so once.
      if (!this.cooling(service)) console.warn(`[huddle] memory: the ${service} API failed, so search goes on without it for a minute:`, error instanceof Error ? error.message : String(error));
      this.downUntil.set(service, Date.now() + COOL_DOWN_MS);
      return fallback;
    }
  }
}
