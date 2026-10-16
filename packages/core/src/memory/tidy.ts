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
  /** merge: the one note that replaces them. */
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

const TIDY = `You tidy up someone's memory: short notes their assistants read, all about one part of their life. Find two things. 1) Notes that say the same thing, or where every fact in one note is also in another: merge them into one note that keeps every fact they hold, adds nothing that isn't in them, and is no longer than it needs to be. 2) Notes that can't both be true now, like two different home cities, two prices for the same plan, or an old and a new phone number: list them (the newer note is often the right one, but the person decides). Leave alone notes that are only related, and notes about different events: two bills, two trips or two visits are not copies. A note goes in one item at most. Answer with JSON only: {"merge": [{"notes": [<numbers>], "note": "<the one note>", "why": "<a short line>"}], "conflicts": [{"notes": [<numbers>], "why": "<a short line>"}]}, with empty lists when the notes are tidy.`;

const listed = (slice: string, notes: readonly Note[]): string =>
  `The "${slice}" notes, oldest first, each with the day it was written:\n${notes.map((note, index) => `${index + 1}. (${note.createdAt.slice(0, 10)}) ${note.note}`).join("\n")}`;

const wordsOf = (text: string): string[] => text.match(/[\p{L}\p{N}](?:[\p{L}\p{N}'’.,:/-]*[\p{L}\p{N}])?/gu) ?? [];

/** Whether a merged note names nothing its notes don't: every number, and every capitalised word past a sentence's first, is in one of them. */
export function addsNothing(merged: string, sources: readonly string[]): boolean {
  const known = new Set(sources.flatMap(wordsOf).map((word) => word.toLowerCase()));
  return merged
    .split(/(?<=[.!?])\s+/)
    .flatMap((sentence) => wordsOf(sentence).filter((word, index) => /\d/.test(word) || (index > 0 && /^\p{Lu}/u.test(word))))
    .every((word) => known.has(word.toLowerCase()));
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
const line = (value: unknown, otherwise: string): string => (typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : otherwise);

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
  const found: TidyProposal[] = [];
  for (const item of items(record(answer).conflicts)) {
    const picked = pick(item.notes);
    if (!picked) continue;
    take(picked);
    found.push(proposal("conflict", slice, picked, line(item.why, "These can't all be true.")));
  }
  for (const item of items(record(answer).merge)) {
    const picked = pick(item.notes);
    const merged = typeof item.note === "string" ? item.note.trim() : "";
    if (!picked || !merged || merged.length > 500 || findSecret(merged)) continue;
    if (!addsNothing(merged, picked.map((note) => note.note))) continue;
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
