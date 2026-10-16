import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dollars, plural } from "../src/format.ts";

describe("numbers on the page", () => {
  it("writes dollars readably, with the sign", () => {
    assert.equal(dollars(0), "$0");
    assert.equal(dollars(0.00035), "$0.00035");
    assert.equal(dollars(1.25), "$1.25");
  });

  it("counts in words", () => {
    assert.equal(plural(1, "copy", "copies"), "1 copy");
    assert.equal(plural(3, "note"), "3 notes");
  });
});
