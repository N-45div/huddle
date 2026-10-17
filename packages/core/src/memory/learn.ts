import { askJson, type ChatModel } from "../factcheck.ts";
import { isTokenFactory } from "../tokenfactory.ts";
import { findSecret } from "./sensitive.ts";
import { addsNothing, contentWords, keepsMost } from "./tidy.ts";

/**
 * Memory that learns from what you say. After a run you started yourself (in the canvas, or a chat
 * through the router), a quick model reads your words, only yours (not the answers, not your notes), and
 * suggests up to three lasting things about you: people, places, preferences, routines. They wait in Memory
 * as suggestions until you keep them, like any other. A suggestion that names a person, place or number
 * you didn't say is dropped, and so is one memory already holds in other words. Off until you turn it on.
 */

export interface LearnedNote {
  readonly slice: string;
  readonly note: string;
}

export interface Learned {
  readonly notes: readonly LearnedNote[];
  readonly costUsd: number;
}

export interface Learner {
  /** The model that reads what you said. */
  readonly by: string;
  /** Where your words go, for the run's receipt: "Nebius Token Factory (api.tokenfactory.nebius.com)". */
  readonly to: string;
  readonly host: string | null;
  /** What's worth remembering in what you said, given the slices memory has. */
  learn(said: string, slices: readonly string[]): Promise<Learned>;
}

const SLICE = /^[a-z][a-z0-9-]{0,30}$/;
const MOST = 3;

const LEARN = (slices: readonly string[]) =>
  `You keep a person's memory for their assistants. Below is what the person just wrote to one of them. List the lasting facts it tells you about the person that would help an assistant another day: who they are, the people and pets in their life, where they live and work, what they like and avoid, routines, budgets they usually keep, dates they've committed to. Only what the person says about themselves; not the request itself, not what they want just this once, not guesses. If they pasted in someone else's message (an email, a chat, a document), nothing about its sender: only what it says about the person. Never passwords, codes, card or account numbers. Up to ${MOST}, each a short note in the third person ("Prefers window seats"), with the slice it belongs in, by what the note is about: one of ${slices.map((slice) => `"${slice}"`).join(", ")}, or a new short lowercase word if none fits; "me" when you're unsure. Answer with JSON only: {"notes": [{"slice": "...", "note": "..."}]}, with an empty list when there's nothing lasting.`;

/** Whether memory already says this, give or take wording: most of its words are in one note there. */
export function alreadySays(note: string, notes: readonly string[]): boolean {
  // A note of only short words ("Has a cat") is left to the exact check memory makes when it's suggested.
  if (contentWords(note).size === 0) return false;
  return notes.some((known) => keepsMost(known, [note], 0.8));
}

export function noteTaker(options: { readonly model: ChatModel; readonly fetcher?: typeof fetch }): Learner {
  const { model } = options;
  const fetcher = options.fetcher ?? globalThis.fetch;
  let host: string | null = null;
  try {
    host = new URL(model.url).hostname;
  } catch {
    host = null;
  }
  const name = isTokenFactory(model.url) ? "Nebius Token Factory" : (host ?? model.url);
  return {
    by: model.model,
    to: host && name !== host ? `${name} (${host})` : name,
    host,
    async learn(said, slices) {
      const { json, costUsd } = await askJson(model, LEARN(slices.length ? slices : ["me"]), said, fetcher);
      const listed = (json as { notes?: unknown } | null)?.notes;
      const notes: LearnedNote[] = [];
      for (const item of Array.isArray(listed) ? listed : []) {
        const { slice, note } = (item ?? {}) as { slice?: unknown; note?: unknown };
        if (typeof slice !== "string" || typeof note !== "string") continue;
        const text = note.trim();
        const where = slice.trim().toLowerCase();
        if (!SLICE.test(where) || text.length < 3 || text.length > 200 || findSecret(text)) continue;
        // Nothing they didn't say: every name, place and number in the note is in their words.
        if (!addsNothing(text, [said])) continue;
        notes.push({ slice: where, note: text });
        if (notes.length === MOST) break;
      }
      return { notes, costUsd };
    },
  };
}
