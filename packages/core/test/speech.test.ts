import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nemoSpeech, numberWords, sentences, speechLanguage, spokenForm, wav } from "../src/speech.ts";

describe("speech on this machine", () => {
  it("says numbers, money, times and dates the way a person would", () => {
    assert.equal(numberWords(1240), "one thousand two hundred forty");
    assert.equal(numberWords(4.5), "four point five");
    assert.equal(numberWords(0), "zero");
    assert.equal(spokenForm("Hermes wants to book the 6:40 train for ₹1,240."), "Hermes wants to book the six forty train for one thousand two hundred forty rupees.");
    assert.equal(spokenForm("Pay $450 by 2026-10-20?"), "Pay four hundred fifty dollars by twentieth October twenty twenty six?");
    assert.equal(spokenForm("Meet at 3:30 PM on the 12th; 20% over & till 06:00."), "Meet at three thirty p m on the twelfth; twenty percent over and till six o'clock.");
    assert.equal(spokenForm("See **this** at https://example.com/x"), "See this at a link");
  });

  it("speaks Hindi as Hindi, and splits long text into sentences", () => {
    assert.equal(speechLanguage("आपकी बैठक साढ़े तीन बजे शुरू होगी।"), "hi-IN");
    assert.equal(speechLanguage("Your meeting starts at three."), "en-US");
    assert.deepEqual(sentences("First one. Second one! Third? पहला। Done."), ["First one.", "Second one!", "Third?", "पहला।", "Done."]);
    assert.ok(sentences("word ".repeat(100), 60).every((part) => part.length <= 60));
  });

  it("wraps audio as a WAV, sends it to listen, and asks for 16 kHz PCM back", async () => {
    const asked: { url: string; body: unknown }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      asked.push({ url, body: init.body });
      if (url.endsWith("/v1/audio/transcriptions")) return Response.json({ text: " hello there " });
      return new Response(new Uint8Array([1, 2, 3, 4]));
    }) as typeof fetch;
    const speech = nemoSpeech({ url: "http://127.0.0.1:8090/", fetcher });
    const pcm = new Uint8Array(16_000);
    assert.equal(await speech.transcribe(pcm), "hello there");
    const form = asked[0]!.body as FormData;
    const file = form.get("file") as Blob;
    assert.equal(file.size, 44 + pcm.byteLength);
    assert.equal(new TextDecoder().decode((await file.arrayBuffer()).slice(0, 4)), "RIFF");
    assert.deepEqual([...(await speech.speak("Hi"))], [1, 2, 3, 4]);
    assert.deepEqual(JSON.parse(String(asked[1]!.body)), { model: "magpie", input: "Hi", language: "en-US", voice: "Aria", sample_rate: 16000, response_format: "pcm" });
    assert.equal(await speech.transcribe(new Uint8Array(100)), "", "too short to hold words: not sent");
    assert.equal(asked.length, 2);
    assert.equal(wav(new Uint8Array(10)).byteLength, 54);
  });
});
