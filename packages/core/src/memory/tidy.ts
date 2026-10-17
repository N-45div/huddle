import { askJson, type ChatModel } from "../factcheck.ts";
import type { Note } from "../store.ts";
import { findSecret } from "./sensitive.ts";

/**
 * Tidying memory up. Notes pile up as flows suggest them, and some end up saying the same thing twice, or
 * no longer agree. Exact copies (give or take case, spacing and a full stop) are found here, with no model.
 * When a model is set up, it reads each slice's kept notes on their own, never two slices together (so a
 * merge can't move a note to assistants that weren't allowed to see it), for notes that say the same thing
 * in other words and notes that can't both be true. This only proposes: nothing changes until the person
 * says so, and a merged note that names a person, place or number its notes don't is dropped.
 */

export type TidyKind = "copies" | "merge" | "conflict";

export interface TidyProposal {
  /** The kind and its notes, so a page can keep track of it. */
  readonly id: string;
  readonly kind: TidyKind;
  readonly slice: string;
  /** The notes it's about, oldest first. */
  readonly notes: readonly Note[];
  /** copies: the note to keep (a kept one before a suggestion); the others go. */
  readonly keep?: string;
  /** merge: the one note that replaces them. conflict, when the model offers one: them as one note, going by the newer. */
  readonly merged?: string;
  /** Why, in plain words. */
  readonly why: string;
}

export interface Tidy {
  /** Notes that disagree first, then ones to merge, then copies. */
  readonly proposals: readonly TidyProposal[];
  /** Notes looked at. */
  readonly looked: number;
  /** Kept notes a model read, and which model: 0 and null when only exact copies were looked for. */
  readonly sent: number;
  readonly readBy: string | null;
  /** Where those notes went. */
  readonly sentTo: readonly string[];
  readonly costUsd: number;
  /** Slices the model couldn't read this time. */
  readonly failed: readonly string[];
}

export interface TidyOptions {
  /** Reads each slice for notes that say the same or disagree; without one, only exact copies are found. */
  readonly model?: ChatModel;
  /** The most kept notes of one slice the model reads, the newest (default 60). */
  readonly perSlice?: number;
  readonly fetcher?: typeof fetch;
}

/** A note's words for comparing: case, spacing, quote and dash styles and closing punctuation don't count. */
export function noteKey(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  let end = words.length;
  while (end > 0 && ".!;, ".includes(words[end - 1]!)) end--;
  return words.slice(0, end);
}

const TIDY = `You tidy up someone's memory: short notes their assistants read, all about one part of their life. Find two things. 1) Notes that say the same thing, or where every fact in one note is also in another: merge them into one note that keeps every fact they hold, adds nothing that isn't in them, and is no longer than it needs to be. 2) Notes that can't both be true now, like two different home cities, two prices for the same plan, or an old and a new phone number: list them, with one note that keeps everything else they say and goes by the newer note where they disagree (the person decides). Leave alone notes that are only related, and notes about different events: two bills, two trips or two visits are not copies. A note goes in one item at most. Each "why" is a short line for the person, in plain words about what the notes say; never mention the notes' numbers. Answer with JSON only: {"merge": [{"notes": [<numbers>], "note": "<the one note>", "why": "..."}], "conflicts": [{"notes": [<numbers>], "note": "<the one note, by the newer>", "why": "..."}]}, with empty lists when the notes are tidy.`;

const listed = (slice: string, notes: readonly Note[]): string =>
  `The "${slice}" notes, oldest first, each with the day it was written:\n${notes.map((note, index) => `${index + 1}. (${note.createdAt.slice(0, 10)}) ${note.note}`).join("\n")}\n\nIn each "why", say what the notes say, never their numbers. A conflict's one note keeps every other fact in them.`;

const wordsOf = (text: string): string[] => text.match(/[\p{L}\p{N}](?:[\p{L}\p{N}'’.,:/-]*[\p{L}\p{N}])?/gu) ?? [];

/** Whether a merged note names nothing its notes don't: every number, and every capitalised word past a sentence's first, is in one of them. */
export function addsNothing(merged: string, sources: readonly string[]): boolean {
  const known = new Set(sources.flatMap(wordsOf).map((word) => word.toLowerCase()));
  return merged
    .split(/(?<=[.!?])\s+/)
    .flatMap((sentence) => wordsOf(sentence).filter((word, index) => /\d/.test(word) || (index > 0 && /^\p{Lu}/u.test(word))))
    .every((word) => known.has(word.toLowerCase()));
}

const COMMON = new Set(["that", "this", "with", "from", "have", "been", "were", "they", "them", "their", "about", "into", "than", "then", "each", "also", "only", "just", "very", "what", "when", "where", "which", "while", "would", "could", "should", "there", "these", "those", "does", "over", "more", "most", "some", "such", "will"]);
export const contentWords = (text: string): Set<string> => new Set(text.toLowerCase().split(/[^\p{L}]+/u).filter((word) => word.length >= 4 && !COMMON.has(word)));

/**
 * Whether one note keeps most of what its notes say (share of their words of four letters or more, default
 * 60%). A model asked to keep every fact can still drop half a note; this catches it. A conflict's one note
 * loses the older fact on purpose, so the bar isn't all of them.
 */
export function keepsMost(merged: string, sources: readonly string[], share = 0.6): boolean {
  const wanted = new Set(sources.flatMap((source) => [...contentWords(source)]));
  if (wanted.size === 0) return true;
  const have = contentWords(merged);
  return [...wanted].filter((word) => have.has(word)).length / wanted.size >= share;
}

/** A model's reason without the numbers its notes had in the prompt, which mean nothing on the page. */
export function plainWhy(why: string): string {
  const said = new Map<string, string>();
  return why.replace(/\b(notes?)\s+(\d+(?:\s*(?:,|and|&)\s*\d+)*)/gi, (_match, word: string, numbers: string) => {
    let words = "these notes";
    if (word.toLowerCase() === "note") {
      if (!said.has(numbers)) said.set(numbers, ["one note", "the other"][said.size] ?? "another");
      words = said.get(numbers)!;
    }
    return word[0] === "N" ? words[0]!.toUpperCase() + words.slice(1) : words;
  });
}

const KIND_ORDER: Readonly<Record<TidyKind, number>> = { conflict: 0, merge: 1, copies: 2 };

const proposal = (kind: TidyKind, slice: string, notes: readonly Note[], why: string, extra: Partial<TidyProposal> = {}): TidyProposal => ({
  id: `${kind}:${notes.map((note) => note.id).join(",")}`,
  kind,
  slice,
  notes,
  why,
  ...extra,
});

/** One slice's notes grouped by their words: copies proposed, and one kept note per wording for the model. */
function copiesIn(slice: string, notes: readonly Note[]): { proposals: TidyProposal[]; unique: Note[] } {
  const byWords = new Map<string, Note[]>();
  for (const note of notes) {
    const key = noteKey(note.note);
    byWords.set(key, [...(byWords.get(key) ?? []), note]);
  }
  const proposals: TidyProposal[] = [];
  const unique: Note[] = [];
  for (const same of byWords.values()) {
    const keep = same.find((note) => note.status === "kept") ?? same[0]!;
    if (keep.status === "kept") unique.push(keep);
    if (same.length < 2) continue;
    const others = same.filter((note) => note !== keep);
    let why = `The same note ${same.length} times.`;
    if (keep.status === "kept" && others.every((note) => note.status === "suggested")) {
      why = others.length === 1 ? "Already kept: this suggestion says the same." : `Already kept: ${others.length} suggestions say the same.`;
    }
    proposals.push(proposal("copies", slice, same, why, { keep: keep.id }));
  }
  return { proposals, unique };
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});
const items = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.map(record) : []);
const line = (value: unknown, otherwise: string): string => (typeof value === "string" && value.trim() ? plainWhy(value.trim()).slice(0, 200) : otherwise);

/** What the model proposed for one slice, checked: real note numbers, each note once, merges that add nothing. */
function proposalsFrom(slice: string, notes: readonly Note[], answer: unknown): TidyProposal[] {
  const used = new Set<number>();
  const pick = (value: unknown): Note[] | null => {
    if (!Array.isArray(value)) return null;
    const numbers = [...new Set(value as unknown[])];
    const real = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= notes.length && !used.has(n);
    if (numbers.length < 2 || !numbers.every(real)) return null;
    return (numbers as number[]).sort((a, b) => a - b).map((n) => notes[n - 1]!);
  };
  const take = (picked: readonly Note[]) => picked.forEach((note) => used.add(notes.indexOf(note) + 1));
  /** The one note a model offers, if it's fit to keep: short, no secret, nothing its notes don't say, and most of what they do. */
  const fit = (value: unknown, picked: readonly Note[]): string | null => {
    const merged = typeof value === "string" ? value.trim() : "";
    if (!merged || merged.length > 500 || findSecret(merged)) return null;
    const sources = picked.map((note) => note.note);
    return addsNothing(merged, sources) && keepsMost(merged, sources) ? merged : null;
  };
  const found: TidyProposal[] = [];
  for (const item of items(record(answer).conflicts)) {
    const picked = pick(item.notes);
    if (!picked) continue;
    take(picked);
    // A conflict stands without its one note: the person can still keep just one of them.
    const merged = fit(item.note, picked);
    found.push(proposal("conflict", slice, picked, line(item.why, "These can't all be true."), merged ? { merged } : {}));
  }
  for (const item of items(record(answer).merge)) {
    const picked = pick(item.notes);
    const merged = picked && fit(item.note, picked);
    if (!picked || !merged) continue;
    take(picked);
    found.push(proposal("merge", slice, picked, line(item.why, "These say the same thing."), { merged }));
  }
  return found;
}

/** Runs the work on a few items at a time. */
async function inTurns<T, R>(list: readonly T[], at: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const index = next++;
      out[index] = await work(list[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(at, list.length) }, worker));
  return out;
}

export async function tidyMemory(notes: readonly Note[], options: TidyOptions = {}): Promise<Tidy> {
  const bySlice = new Map<string, Note[]>();
  for (const note of [...notes].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) bySlice.set(note.slice, [...(bySlice.get(note.slice) ?? []), note]);

  const proposals: TidyProposal[] = [];
  const toRead: { slice: string; notes: Note[] }[] = [];
  for (const [slice, list] of bySlice) {
    const { proposals: copies, unique } = copiesIn(slice, list);
    proposals.push(...copies);
    if (unique.length >= 2) toRead.push({ slice, notes: unique.slice(-(options.perSlice ?? 60)) });
  }

  const model = options.model;
  const fetcher = options.fetcher ?? globalThis.fetch;
  let sent = 0;
  let costUsd = 0;
  const failed: string[] = [];
  if (model && toRead.length > 0) {
    const read = await inTurns(toRead, 3, async (job) => {
      try {
        return { ...job, ...(await askJson(model, TIDY, listed(job.slice, job.notes), fetcher)) };
      } catch {
        return { ...job, json: null, costUsd: 0 };
      }
    });
    for (const job of read) {
      sent += job.notes.length;
      costUsd += job.costUsd;
      if (job.json === null) failed.push(job.slice);
      else proposals.push(...proposalsFrom(job.slice, job.notes, job.json));
    }
  }

  let host: string | null = null;
  try {
    host = model ? new URL(model.url).hostname : null;
  } catch {
    host = null;
  }
  proposals.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.slice.localeCompare(b.slice));
  return { proposals, looked: notes.length, sent, readBy: sent > 0 && model ? model.model : null, sentTo: sent > 0 && host ? [host] : [], costUsd, failed };
}
