/**
 * Voice, kept on your own machine: NVIDIA's NeMo-Speech.cpp serving Nemotron 3.5 ASR (speech to text,
 * 40 locales including Hindi) and Magpie TTS (text to speech) behind its OpenAI-style routes. The Huddle
 * button streams 16 kHz mono 16-bit PCM in and plays the same back. Audio goes to this local server and
 * nowhere else; only the text it turns into goes on to the assistants.
 */

export const SAMPLE_RATE = 16_000;

export interface Speech {
  /** What does the listening and speaking, for logs and receipts. */
  readonly name: string;
  readonly url: string;
  /** Speech audio (16 kHz mono 16-bit PCM) to text. */
  transcribe(pcm: Uint8Array, options?: { readonly language?: string; readonly signal?: AbortSignal }): Promise<string>;
  /** Text to speech audio (16 kHz mono 16-bit PCM). Say it in spoken form first (spokenForm). */
  speak(text: string, options?: { readonly language?: string; readonly voice?: string; readonly signal?: AbortSignal }): Promise<Uint8Array<ArrayBuffer>>;
}

export interface NemoSpeechOptions {
  /** Where NeMo-Speech.cpp serves (`nemo-speech serve`), e.g. http://127.0.0.1:8090. */
  readonly url: string;
  readonly key?: string;
  /** ASR language: a locale like "en-US" or "hi-IN", or "auto" (default). */
  readonly language?: string;
  /** Magpie's voice: Aria, Jason, John, Leo or Sofia (default Aria). */
  readonly voice?: string;
  readonly fetcher?: typeof fetch;
}

/** A WAV file around 16-bit mono PCM, for the transcription route. */
export function wav(pcm: Uint8Array, sampleRate = SAMPLE_RATE): Uint8Array<ArrayBuffer> {
  const header = new DataView(new ArrayBuffer(44));
  const text = (offset: number, value: string) => [...value].forEach((char, index) => header.setUint8(offset + index, char.charCodeAt(0)));
  text(0, "RIFF");
  header.setUint32(4, 36 + pcm.byteLength, true);
  text(8, "WAVE");
  text(12, "fmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  text(36, "data");
  header.setUint32(40, pcm.byteLength, true);
  const out = new Uint8Array(44 + pcm.byteLength);
  out.set(new Uint8Array(header.buffer), 0);
  out.set(pcm, 44);
  return out;
}

/** Which Magpie locale reads this text: Hindi when it's mostly Devanagari, else English. */
export function speechLanguage(text: string): string {
  const devanagari = (text.match(/[ऀ-ॿ]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return devanagari > latin ? "hi-IN" : "en-US";
}

export function nemoSpeech(options: NemoSpeechOptions): Speech {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const base = options.url.replace(/\/+$/, "");
  const auth: Record<string, string> = options.key ? { authorization: `Bearer ${options.key}` } : {};
  const said = async (response: Response, what: string): Promise<never> => {
    const body = (await response.json().catch(() => null)) as { error?: { message?: unknown } | string } | null;
    const message = typeof body?.error === "string" ? body.error : typeof body?.error?.message === "string" ? body.error.message : `HTTP ${response.status}`;
    throw new Error(`The speech server couldn't ${what}: ${message}`);
  };
  return {
    name: "Nemotron 3.5 ASR and Magpie TTS (NVIDIA NeMo-Speech, on this machine)",
    url: base,
    async transcribe(pcm, call = {}) {
      if (pcm.byteLength < SAMPLE_RATE / 5) return ""; // under a tenth of a second: nothing said
      const form = new FormData();
      form.append("file", new Blob([wav(pcm)], { type: "audio/wav" }), "speech.wav");
      form.append("model", "nemotron-3.5");
      const language = call.language ?? options.language ?? "auto";
      if (language !== "auto") form.append("language", language);
      const response = await fetcher(`${base}/v1/audio/transcriptions`, { method: "POST", headers: auth, body: form, signal: call.signal ?? AbortSignal.timeout(60_000) });
      if (!response.ok) return said(response, "listen");
      const body = (await response.json().catch(() => null)) as { text?: unknown } | null;
      return typeof body?.text === "string" ? body.text.trim() : "";
    },
    async speak(text, call = {}) {
      const response = await fetcher(`${base}/v1/audio/speech`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ model: "magpie", input: text, language: call.language ?? speechLanguage(text), voice: call.voice ?? options.voice ?? "Aria", sample_rate: SAMPLE_RATE, response_format: "pcm" }),
        signal: call.signal ?? AbortSignal.timeout(60_000),
      });
      if (!response.ok) return said(response, "speak");
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

// Spoken form ------------------------------------------------------------------------------------------
// Magpie on Windows has no text normalization: "3:30 PM" and "$15" come out garbled. These turn numbers,
// money, times and symbols into the words a person would say, in English.

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES: readonly [number, string][] = [
  [1e12, "trillion"],
  [1e9, "billion"],
  [1e6, "million"],
  [1e3, "thousand"],
];

function under1000(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundreds) parts.push(`${ONES[hundreds]} hundred`);
  if (rest) parts.push(rest < 20 ? ONES[rest]! : `${TENS[Math.floor(rest / 10)]}${rest % 10 ? ` ${ONES[rest % 10]}` : ""}`);
  return parts.join(" ") || "zero";
}

/** A number in words: 1240 is "one thousand two hundred forty"; 4.5 is "four point five". */
export function numberWords(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value < 0) return `minus ${numberWords(-value)}`;
  const [whole, fraction] = String(value).split(".");
  let n = Number(whole);
  const parts: string[] = [];
  if (n === 0) parts.push("zero");
  for (const [size, name] of SCALES) {
    if (n >= size) {
      parts.push(`${under1000(Math.floor(n / size))} ${name}`);
      n %= size;
    }
  }
  if (n > 0) parts.push(under1000(n));
  const words = parts.join(" ");
  return fraction ? `${words} point ${[...fraction].map((digit) => ONES[Number(digit)]).join(" ")}` : words;
}

/** A year as people say it: 2026 is "twenty twenty six", 2005 "two thousand five". */
function yearWords(year: number): string {
  const first = Math.floor(year / 100);
  const last = year % 100;
  if (last === 0) return `${numberWords(first)} hundred`;
  if (year >= 2000 && year < 2010) return numberWords(year);
  return `${numberWords(first)} ${last < 10 ? `oh ${ONES[last]}` : numberWords(last)}`;
}

const ORDINAL: Readonly<Record<string, string>> = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };
function ordinalWords(n: number): string {
  const words = numberWords(n).split(" ");
  const last = words.pop()!;
  const ordinal = ORDINAL[last] ?? (last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return [...words, ordinal].join(" ");
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const plain = (digits: string) => Number(digits.replace(/,/g, ""));

/** The text as a person would say it: numbers, money, times, dates and symbols in words. */
export function spokenForm(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/[*_`#>]+/g, "")
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_m, y: string, mo: string, d: string) => `${ordinalWords(Number(d))} ${MONTHS[Number(mo) - 1] ?? mo} ${yearWords(Number(y))}`)
    .replace(/(?:₹|Rs\.?|INR)\s?(\d[\d,]*(?:\.\d+)?)/gi, (_m, n: string) => `${numberWords(plain(n))} rupees`)
    .replace(/\$\s?(\d[\d,]*(?:\.\d+)?)/g, (_m, n: string) => `${numberWords(plain(n))} dollars`)
    .replace(/€\s?(\d[\d,]*(?:\.\d+)?)/g, (_m, n: string) => `${numberWords(plain(n))} euros`)
    .replace(/£\s?(\d[\d,]*(?:\.\d+)?)/g, (_m, n: string) => `${numberWords(plain(n))} pounds`)
    .replace(/\b(\d{1,2}):(\d{2})\s?([AaPp])\.?[Mm]\.?/g, (_m, h: string, m: string, ap: string) => `${numberWords(Number(h))}${m === "00" ? "" : ` ${Number(m) < 10 ? `oh ${ONES[Number(m)]}` : numberWords(Number(m))}`} ${ap.toLowerCase() === "a" ? "a m" : "p m"}`)
    .replace(/\b(\d{1,2}):(\d{2})\b/g, (_m, h: string, m: string) => `${numberWords(Number(h))} ${m === "00" ? "o'clock" : Number(m) < 10 ? `oh ${ONES[Number(m)]}` : numberWords(Number(m))}`)
    .replace(/(\d[\d,]*(?:\.\d+)?)\s?%/g, (_m, n: string) => `${numberWords(plain(n))} percent`)
    .replace(/\b(\d+)(?:st|nd|rd|th)\b/g, (_m, n: string) => ordinalWords(Number(n)))
    .replace(/\b(1[89]\d{2}|20\d{2})\b/g, (_m, y: string) => yearWords(Number(y)))
    .replace(/\d[\d,]*(?:\.\d+)?/g, (n) => numberWords(plain(n)))
    .replace(/&/g, " and ")
    .replace(/@/g, " at ")
    .replace(/\s*[/|]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Text split into sentences short enough to speak one at a time, so the first plays while the rest is made. */
export function sentences(text: string, max = 220): string[] {
  const out: string[] = [];
  for (const sentence of text.split(/(?<=[.!?।])\s+/)) {
    let rest = sentence.trim();
    while (rest.length > max) {
      const cut = Math.max(rest.lastIndexOf(", ", max), rest.lastIndexOf(" ", max));
      out.push(rest.slice(0, cut > 0 ? cut : max).trim());
      rest = rest.slice(cut > 0 ? cut + 1 : max).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}
