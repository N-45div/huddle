import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addsNothing, noteKey, tidyMemory } from "../src/memory/tidy.ts";
import { type Note, Store } from "../src/store.ts";
import { NEMOTRON, TOKEN_FACTORY_URL } from "../src/tokenfactory.ts";

let day = 0;
const note = (slice: string, text: string, status: Note["status"] = "kept"): Note => ({ id: `note_${++day}`, slice, note: text, status, source: "you", createdAt: `2026-10-${String(day).padStart(2, "0")}T09:00:00.000Z` });

/** Token Factory answering each slice with what `says` has for it, recording what it read. */
function model(says: Record<string, unknown>, failFor?: string) {
  const read: { slice: string; user: string; thinking: unknown }[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: { content: string }[]; chat_template_kwargs?: unknown };
    const user = body.messages[1]!.content;
    const slice = /^The "([^"]+)" notes/.exec(user)![1]!;
    read.push({ slice, user, thinking: body.chat_template_kwargs });
    if (slice === failFor) return Response.json({ error: { message: "overloaded" } }, { status: 503 });
    return Response.json({ choices: [{ message: { content: JSON.stringify(says[slice] ?? { merge: [], conflicts: [] }) } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } });
  }) as typeof fetch;
  return { options: { model: { url: TOKEN_FACTORY_URL, model: NEMOTRON.super, key: "tf" }, fetcher }, read };
}

describe("tidying memory up", () => {
  it("compares notes by their words, not their case, spacing or full stop", () => {
    assert.equal(noteKey("  Lives in  Bengaluru. "), noteKey("lives in bengaluru"));
    assert.equal(noteKey("Prefers ‘window’ seats!"), noteKey("prefers 'window' seats"));
    assert.notEqual(noteKey("Lives in Bengaluru"), noteKey("Lives in Pune"));
  });

  it("doesn't add a note the slice already holds", () => {
    const store = new Store();
    const kept = store.remember("me", "Lives in Bengaluru.");
    assert.equal(store.suggest("me", "lives in bengaluru", "run 1").id, kept.id, "already kept: no new suggestion");
    const waiting = store.suggest("me", "Allergic to peanuts", "run 2");
    assert.equal(store.suggest("me", "Allergic to peanuts.", "run 3").id, waiting.id, "already suggested: not again");
    assert.notEqual(store.suggest("home", "Lives in Bengaluru", "run 4").id, kept.id, "another slice is its own");
    const typed = store.remember("me", "allergic to peanuts");
    assert.equal(typed.id, waiting.id);
    assert.equal(typed.status, "kept", "writing it yourself keeps the suggestion");
    assert.equal(store.notes().length, 3);
  });

  it("finds exact copies with no model, keeping a kept note over a suggestion", async () => {
    const notes = [note("me", "Lives in Bengaluru", "suggested"), note("me", "Lives in Bengaluru."), note("me", "lives in bengaluru", "suggested"), note("money", "Rent is due on the 5th")];
    const tidy = await tidyMemory(notes);
    assert.equal(tidy.proposals.length, 1);
    const [copies] = tidy.proposals;
    assert.equal(copies!.kind, "copies");
    assert.equal(copies!.keep, notes[1]!.id);
    assert.equal(copies!.notes.length, 3);
    assert.match(copies!.why, /Already kept: 2 suggestions/);
    assert.deepEqual({ looked: tidy.looked, sent: tidy.sent, readBy: tidy.readBy, sentTo: tidy.sentTo }, { looked: 4, sent: 0, readBy: null, sentTo: [] });
  });

  it("asks Nemotron about each slice on its own, and checks what it proposes", async () => {
    const me = [note("me", "Lives in Bengaluru"), note("me", "Has a dog called Biscuit"), note("me", "Moved to Pune in September 2026"), note("me", "Dog's name is Biscuit, a beagle"), note("me", "Prefers window seats")];
    const money = [note("money", "Netflix costs 649 a month"), note("money", "Netflix plan: 649 rupees monthly"), note("money", "Gym membership 1,200 a month")];
    const { options, read } = model({
      me: {
        conflicts: [{ notes: [1, 3], why: "Two home cities." }],
        merge: [
          { notes: [2, 4], note: "Has a beagle called Biscuit", why: "Same dog." },
          { notes: [3, 5], note: "Moved to Pune", why: "Overlaps a note already in a conflict." },
        ],
      },
      money: {
        merge: [
          { notes: [1, 2], note: "Netflix costs 649 rupees a month on the Premium plan", why: "Adds a plan name that isn't in either." },
          { notes: [3, 9], note: "x", why: "No note 9." },
        ],
        conflicts: [],
      },
    });
    const tidy = await tidyMemory([...me, ...money, note("work", "Standup at 10")], options);

    assert.deepEqual(read.map((call) => call.slice).sort(), ["me", "money"], "one call per slice; a slice of one note isn't sent");
    assert.ok(read.every((call) => !call.user.includes(call.slice === "me" ? "Netflix" : "Biscuit")), "a slice's notes never travel with another's");
    assert.ok(read.every((call) => JSON.stringify(call.thinking) === JSON.stringify({ enable_thinking: false })));
    assert.ok(read.find((call) => call.slice === "me")!.user.includes("3. (2026-10-"), "numbered, with the day each was written");

    assert.deepEqual(
      tidy.proposals.map((found) => [found.kind, found.slice, found.notes.map((one) => one.note)]),
      [
        ["conflict", "me", ["Lives in Bengaluru", "Moved to Pune in September 2026"]],
        ["merge", "me", ["Has a dog called Biscuit", "Dog's name is Biscuit, a beagle"]],
      ],
      "a merge that names something new, a note number that isn't there and a note used twice are all dropped",
    );
    assert.equal(tidy.proposals[1]!.merged, "Has a beagle called Biscuit");
    assert.equal(tidy.sent, 8);
    assert.equal(tidy.readBy, NEMOTRON.super);
    assert.deepEqual(tidy.sentTo, ["api.tokenfactory.nebius.com"]);
    assert.ok(tidy.costUsd > 0, "Token Factory's price for Super");
  });

  it("says which slices the model couldn't read, and still has the copies", async () => {
    const { options } = model({}, "me");
    const tidy = await tidyMemory([note("me", "Lives in Bengaluru"), note("me", "lives in Bengaluru."), note("me", "Prefers tea")], options);
    assert.deepEqual(tidy.failed, ["me"]);
    assert.deepEqual(tidy.proposals.map((found) => found.kind), ["copies"]);
  });

  it("only lets a merge name people, places and numbers its notes do", () => {
    const sources = ["Has a dog called Biscuit", "Dog's name is Biscuit, a beagle"];
    assert.ok(addsNothing("Has a beagle called Biscuit.", sources));
    assert.ok(addsNothing("Biscuit is a beagle. Has had him since then.", sources), "a sentence's first word can be capitalised");
    assert.equal(addsNothing("Has a beagle called Biscuit, born in 2021", sources), false, "a new number");
    assert.equal(addsNothing("Has a beagle called Biscuit from Mysuru", sources), false, "a new place");
  });

  it("merges notes of one slice into one kept note, all at once", () => {
    const store = new Store();
    const a = store.remember("me", "Has a dog called Biscuit");
    const b = store.remember("me", "Dog's name is Biscuit, a beagle");
    const other = store.remember("home", "Wi-Fi router is in the hall");
    assert.throws(() => store.merge([a.id, other.id], "x"), /same slice/);
    assert.throws(() => store.merge([a.id, "note_gone"], "x"), /isn't in memory/);
    assert.throws(() => store.merge([a.id], "x"), /two notes or more/);
    assert.throws(() => store.merge([a.id, b.id], "Biscuit's vet login password: hunter2hunter2"), /Not saved/);
    assert.equal(store.notes().length, 3, "nothing changed by a refused merge");

    const merged = store.merge([a.id, b.id], "Has a beagle called Biscuit");
    assert.deepEqual(
      store.notes().map((one) => one.note).sort(),
      ["Has a beagle called Biscuit", "Wi-Fi router is in the hall"],
    );
    assert.equal(merged.status, "kept");
    assert.equal(merged.slice, "me");
    assert.match(merged.source, /tidy-up: 2 notes merged/);
  });
});
