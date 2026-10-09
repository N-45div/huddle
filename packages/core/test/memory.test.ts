import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryText } from "../src/connector.ts";
import type { Embedder } from "../src/memory/embeddings.ts";
import { Memory, NOTE_CLIP } from "../src/memory/memory.ts";
import type { Reranker } from "../src/memory/rerank.ts";
import { type Note, Store } from "../src/store.ts";

/** Kept notes, a minute apart in the order given, so "newest" is well defined. */
function keepAll(store: Store, slice: string, notes: readonly string[]): Note[] {
  return notes.map((text) => {
    const note = store.remember(slice, text);
    const at = new Date(Date.UTC(2026, 0, 1, 0, store.notes().length)).toISOString();
    store.db.prepare("UPDATE notes SET created_at = ? WHERE id = ?").run(at, note.id);
    return { ...note, createdAt: at };
  });
}

/** A stand-in embeddings model: one dimension per topic, so "kitten" and "cat" mean the same thing. */
const TOPICS = [["cat", "kitten", "miso", "pet"], ["rent", "landlord", "lease"], ["doctor", "allergy", "allergic", "penicillin"]];
function fakeEmbedder(calls: string[][] = []): Embedder {
  return {
    model: "fake-embed",
    async embed(texts) {
      calls.push([...texts]);
      return texts.map((text) => {
        const words = text.toLowerCase().split(/\W+/);
        return Float32Array.from([...TOPICS.map((topic) => (topic.some((word) => words.includes(word)) ? 1 : 0)), 0.1]);
      });
    },
  };
}
const broken: Embedder = { model: "broken", embed: async () => Promise.reject(new Error("embeddings offline")) };

describe("memory search", () => {
  it("weighs a rare word over a common one, however often the common one appears", async () => {
    const store = new Store();
    keepAll(store, "people", [
      "Asha calls Asha's mum every Sunday, Asha says.",
      "Asha likes the garden.",
      "Asha's birthday is in May.",
      "Asha works at the clinic.",
      "The passport expires in March 2027.",
      "Asha prefers tea.",
    ]);
    const hits = await new Memory(store).search("When does Asha's passport expire?");
    assert.equal(hits[0]?.note.note, "The passport expires in March 2027.");
    // "passport" and "expire" are in one note of six; "Asha" is in five, so it counts for little.
    assert.ok(hits[0]!.match!.weight > 3 * hits[1]!.match!.weight);
    assert.ok(hits[0]!.match!.share > 0.8 && hits[0]!.match!.share < 1);
  });

  it("finds other forms of a word and words written with marks, and ignores stop words", async () => {
    const store = new Store();
    keepAll(store, "money", ["Northwind sends an invoice every month.", "Pays by bank transfer."]);
    keepAll(store, "home", ["मुझे किताब पसंद है"]);
    const memory = new Memory(store);
    assert.equal((await memory.search("invoices"))[0]?.note.note, "Northwind sends an invoice every month.");
    assert.equal((await memory.search("paying"))[0]?.note.note, "Pays by bank transfer.");
    assert.equal((await memory.search("किताब"))[0]?.note.note, "मुझे किताब पसंद है");
    assert.deepEqual(await memory.search("what is the"), []);
  });

  it("searches the first 1,200 characters of a note, and forgets what's forgotten", async () => {
    const store = new Store();
    const [early, late] = keepAll(store, "notes", [`giraffe ${"filler ".repeat(300)}`, `${"filler ".repeat(300)} zebra`]);
    const memory = new Memory(store);
    assert.deepEqual((await memory.search("giraffe")).map((hit) => hit.note.id), [early!.id]);
    assert.deepEqual(await memory.search("zebra"), [], "past the clip");
    store.forget(early!.id);
    assert.deepEqual(await memory.search("giraffe"), []);
    assert.equal(late!.note.length > NOTE_CLIP, true);
  });

  it("only searches the slices and status asked for", async () => {
    const store = new Store();
    keepAll(store, "home", ["The cat is called Miso."]);
    keepAll(store, "health", ["The cat scratched me; saw the doctor."]);
    store.suggest("home", "The cat might be allergic to fish.", "test");
    const memory = new Memory(store);
    assert.equal((await memory.search("cat")).length, 3);
    assert.deepEqual((await memory.search("cat", { slices: ["home"], status: "kept" })).map((hit) => hit.note.note), ["The cat is called Miso."]);
  });
});

describe("memory with vectors and a reranker", () => {
  it("finds a note by meaning, keeps its vector, and only embeds new notes", async () => {
    const store = new Store();
    keepAll(store, "home", ["Miso is a cat.", "Rent is due on the 5th."]);
    const calls: string[][] = [];
    const memory = new Memory(store, { embedder: fakeEmbedder(calls) });
    const hits = await memory.search("my kitten");
    assert.deepEqual(hits.map((hit) => [hit.note.note, hit.match]), [["Miso is a cat.", null]], "no shared word, same meaning");
    assert.equal(calls.length, 2, "the notes, then the query");
    await memory.search("the landlord");
    assert.deepEqual(calls.at(-1), ["the landlord"], "the notes already have vectors");
    keepAll(store, "home", ["Saw the doctor about an allergy."]);
    await memory.search("penicillin");
    assert.deepEqual(calls.slice(-2).flat().sort(), ["Saw the doctor about an allergy.", "penicillin"]);
  });

  it("goes on by words when the embeddings API fails, and leaves it alone for a while", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const store = new Store();
    keepAll(store, "home", ["Miso is a cat."]);
    let tries = 0;
    const flaky: Embedder = { model: "flaky", embed: async () => { tries += 1; throw new Error("embeddings offline"); } };
    const memory = new Memory(store, { embedder: flaky });
    assert.deepEqual((await memory.search("cat")).map((hit) => hit.note.note), ["Miso is a cat."]);
    const after = tries;
    assert.deepEqual((await memory.search("cat")).map((hit) => hit.note.note), ["Miso is a cat."]);
    assert.equal(tries, after, "not asked again straight away");
    assert.ok(warn.mock.callCount() >= 1);
  });

  it("puts the matches in the reranker's order, and keeps its own when the reranker fails", async (t) => {
    t.mock.method(console, "warn", () => {});
    const store = new Store();
    keepAll(store, "home", ["The cat is Miso.", "The cat eats at 7.", "The cat sleeps on the sofa."]);
    const plain = (await new Memory(store).search("cat")).map((hit) => hit.note.note);
    const reverse: Reranker = { model: "reverse", rank: async (_query, documents) => documents.map((_, index) => documents.length - 1 - index) };
    assert.deepEqual((await new Memory(store, { reranker: reverse }).search("cat")).map((hit) => hit.note.note), [...plain].reverse());
    const down: Reranker = { model: "down", rank: async () => Promise.reject(new Error("rerank offline")) };
    assert.deepEqual((await new Memory(store, { reranker: down }).search("cat")).map((hit) => hit.note.note), plain);
  });
});

describe("memory recall", () => {
  const weather = Array.from({ length: 12 }, (_, index) => `Day ${index + 1}: the weather was fine and the garden needed water.`);

  it("sends every kept note in the slices while they fit, in the order they were written", async () => {
    const store = new Store();
    keepAll(store, "home", ["Miso is a cat.", "The boiler is serviced in June."]);
    assert.deepEqual((await new Memory(store).recall("anything", ["home"])).map((note) => note.note), ["Miso is a cat.", "The boiler is serviced in June."]);
  });

  it("past the budget, sends the notes that match the ask first, then the newest, within the budget", async () => {
    const store = new Store();
    keepAll(store, "home", ["Miso the cat is fed at 7 every morning.", ...weather]);
    const budget = 300;
    const sent = await new Memory(store, { budget }).recall("When is Miso fed?", ["home"]);
    assert.ok(memoryText(sent).replaceAll("\n", "").length <= budget);
    assert.equal(sent[0]?.note, "Miso the cat is fed at 7 every morning.", "the oldest note, but the one asked about");
    assert.deepEqual(sent.slice(1).map((note) => note.note), weather.slice(-(sent.length - 1)), "then the newest");
    const unasked = (await new Memory(store, { budget }).recall("", ["home"])).map((note) => note.note);
    assert.deepEqual(unasked, weather.slice(-unasked.length), "nothing asked: the newest");
  });

  it("clips a long note rather than leaving it out", async () => {
    const store = new Store();
    keepAll(store, "home", [`The alarm code is changed monthly. ${"More detail. ".repeat(200)}`]);
    const [note] = await new Memory(store).recall("alarm", ["home"]);
    assert.ok(note && note.note.length <= NOTE_CLIP && note.note.endsWith("…"));
    assert.ok(note.note.startsWith("The alarm code is changed monthly."));
  });

  it("never gives an assistant a note from a slice it wasn't given, however well the note matches", async () => {
    const store = new Store();
    keepAll(store, "home", ["Miso is a cat.", ...weather]);
    keepAll(store, "health", ["Allergic to penicillin: tell any doctor.", "The doctor said the allergy is mild."]);
    const withVectors = new Memory(store, { embedder: fakeEmbedder() });
    await withVectors.search("penicillin allergy doctor", { slices: ["health"] });
    const ask = "Am I allergic to penicillin? Ask the doctor.";
    for (const memory of [new Memory(store), new Memory(store, { budget: 200 }), withVectors, new Memory(store, { budget: 200, embedder: fakeEmbedder() })]) {
      const sent = await memory.recall(ask, ["home"]);
      assert.ok(sent.length > 0);
      assert.deepEqual(sent.filter((note) => note.slice !== "home"), []);
    }
    assert.deepEqual(await withVectors.recall("penicillin", []), [], "no slices, no notes");
    // Given the slice, the same request does reach those notes first.
    const allowed = await new Memory(store, { budget: 200, embedder: fakeEmbedder() }).recall(ask, ["home", "health"]);
    assert.deepEqual(allowed.filter((note) => note.slice === "health").length, 2);
  });

  it("never fails: with every outside API down, it sends the newest that fit", async (t) => {
    t.mock.method(console, "warn", () => {});
    const store = new Store();
    keepAll(store, "home", weather);
    const down: Reranker = { model: "down", rank: async () => Promise.reject(new Error("rerank offline")) };
    const sent = await new Memory(store, { budget: 200, embedder: broken, reranker: down }).recall("weather", ["home"]);
    assert.ok(sent.length > 0 && memoryText(sent).replaceAll("\n", "").length <= 200);
  });
});
