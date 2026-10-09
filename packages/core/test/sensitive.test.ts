import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findSecret, redactSecrets, SensitiveNote } from "../src/memory/sensitive.ts";
import { Store } from "../src/store.ts";

describe("secrets in memory", () => {
  it("knows passwords, PINs, codes, cards and keys, and not postal PIN codes", () => {
    assert.equal(findSecret("My wifi password is hunter22"), "a password");
    assert.equal(findSecret("card number 4111 1111 1111 1111"), "a card number");
    assert.equal(findSecret("Your OTP is 482913"), "a one-time code");
    assert.equal(findSecret("key sk-proj-abcdefghijklmnop1234"), "a secret key");
    assert.equal(findSecret("The PIN code for the office is 560001"), null);
    assert.equal(findSecret("Rent is 25,000 on the 5th."), null);
    assert.equal(redactSecrets("Use card 4111111111111111 for groceries."), "Use card [redacted] for groceries.");
  });

  it("masks secrets in suggestions, refuses to keep one a person writes, and won't keep an old one", () => {
    const store = new Store();
    assert.equal(store.suggest("money", "The UPI PIN is 1234, pays rent.", "test").note, "The [redacted], pays rent.");
    assert.throws(() => store.remember("home", "The alarm password is open-sesame"), SensitiveNote);
    assert.throws(() => store.remember("home", "The alarm password is open-sesame"), /Not saved: this looks like a password/);
    // A suggestion from before suggestions were masked.
    store.db.prepare("INSERT INTO notes (id, slice, note, status, source, created_at) VALUES ('note_old', 'money', 'Card 4111 1111 1111 1111', 'suggested', 'old', ?)").run(new Date().toISOString());
    assert.throws(() => store.keep("note_old"), /Not kept: this looks like a card number/);
    assert.equal(store.notes("kept").length, 0);
  });
});
