import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeFrame, FrameReader, type UsbEvent } from "../src/usb-link.ts";

const bytes = (...parts: (Uint8Array | string)[]) => {
  const chunks = parts.map((part) => (typeof part === "string" ? new TextEncoder().encode(part) : part));
  const all = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  return all;
};

const shapes = (events: UsbEvent[]) => events.map((event) => (event.kind === "audio" ? { kind: "audio", bytes: [...event.bytes] } : event));

describe("the USB link's frames", () => {
  it("encodes a frame as STX, kind, little-endian length and the bytes", () => {
    assert.deepEqual([...encodeFrame("T", "hi")], [0x02, 0x54, 2, 0, 0, 0, 0x68, 0x69]);
    assert.deepEqual([...encodeFrame("B", new Uint8Array([1, 2, 3]))], [0x02, 0x42, 3, 0, 0, 0, 1, 2, 3]);
  });

  it("splits the button's log lines from its frames", () => {
    const reader = new FrameReader();
    const events = reader.push(bytes("[huddle] booting\r\n", encodeFrame("T", '{"type":"usb"}'), "[huddle] mic: left 40\n", encodeFrame("B", new Uint8Array([7, 8]))));
    assert.deepEqual(shapes(events), [
      { kind: "line", text: "[huddle] booting" },
      { kind: "text", text: '{"type":"usb"}' },
      { kind: "line", text: "[huddle] mic: left 40" },
      { kind: "audio", bytes: [7, 8] },
    ]);
  });

  it("puts frames and lines back together however the cable chunks them", () => {
    const stream = bytes("[huddle] one\n", encodeFrame("T", '{"type":"hello","audio":true}'), encodeFrame("B", new Uint8Array(3200).fill(2)), "[huddle] two\n");
    for (const size of [1, 2, 5, 7, 64, 1000]) {
      const reader = new FrameReader();
      const events: UsbEvent[] = [];
      for (let at = 0; at < stream.length; at += size) events.push(...reader.push(stream.slice(at, at + size)));
      assert.deepEqual(
        events.map((event) => (event.kind === "audio" ? `audio ${event.bytes.length}` : `${event.kind} ${event.text}`)),
        ["line [huddle] one", 'text {"type":"hello","audio":true}', "audio 3200", "line [huddle] two"],
        `chunks of ${size}`,
      );
    }
  });

  it("keeps a PCM frame whole when its bytes hold an STX", () => {
    const pcm = new Uint8Array([0x02, 0x54, 9, 9, 0x02, 0x42]);
    assert.deepEqual(shapes(new FrameReader().push(encodeFrame("B", pcm))), [{ kind: "audio", bytes: [...pcm] }]);
  });

  it("treats a stray STX with no frame behind it as noise and reads on", () => {
    const events = new FrameReader().push(bytes(new Uint8Array([0x02, 0x58]), "ok\n", encodeFrame("T", "{}")));
    assert.deepEqual(shapes(events), [
      { kind: "line", text: "Xok" },
      { kind: "text", text: "{}" },
    ]);
  });

  it("reads an empty frame and an unfinished line waits for its end", () => {
    const reader = new FrameReader();
    assert.deepEqual(shapes(reader.push(bytes(encodeFrame("T", ""), "[huddle] half"))), [{ kind: "text", text: "" }]);
    assert.deepEqual(shapes(reader.push(bytes(" a line\n"))), [{ kind: "line", text: "[huddle] half a line" }]);
  });
});
