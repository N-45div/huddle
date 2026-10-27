import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { linkToken } from "../src/api.ts";

describe("a token in a shared link", () => {
  it("reads the token after #token=", () => {
    assert.equal(linkToken("#token=c0ffee1234"), "c0ffee1234");
    assert.equal(linkToken("#token=a%2Bb%3D"), "a+b=");
    assert.equal(linkToken("#token=abc&more"), "abc");
  });

  it("leaves ordinary addresses alone", () => {
    assert.equal(linkToken(""), undefined);
    assert.equal(linkToken("#/flows"), undefined);
    assert.equal(linkToken("#/runs?flow=token"), undefined);
  });

  it("gives an empty token when the link's is empty or broken", () => {
    assert.equal(linkToken("#token="), "");
    assert.equal(linkToken("#token=%E0%A4%A"), "");
  });
});
