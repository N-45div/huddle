import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { base64, encodeFrame, FrameReader, spritePayload, toRgb565, type UsbEvent } from "../src/usb-link.ts";

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
        events.map((event) => (event.kind === "audio" || event.kind === "photo" ? `${event.kind} ${event.bytes.length}` : `${event.kind} ${event.text}`)),
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

  it("reads a photo the button took, and base64s it for Huddle", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0x02, 0x50, 0xff, 0xd9]);
    const events = new FrameReader().push(bytes("[huddle] snap\n", encodeFrame("P", jpeg)));
    assert.deepEqual(shapes(events).map((event) => event.kind), ["line", "photo"]);
    assert.deepEqual(events[1]?.kind === "photo" ? [...events[1].bytes] : [], [...jpeg], "kept whole, STX inside and all");
    assert.equal(base64(jpeg), "/9gCUP/Z");
    assert.equal(base64(new Uint8Array(100_000)).length, 133_336, "a 100 KB photo in one go, no stack overflow");
  });

  it("turns a canvas's RGBA into the screen's RGB565", () => {
    // White, Hud's indigo (#5b63e6), the button's background (#13142a), with alpha ignored.
    assert.deepEqual([...toRgb565([255, 255, 255, 255, 0x5b, 0x63, 0xe6, 255, 0x13, 0x14, 0x2a, 0])], [0xffff, 0x5b1c, 0x10a5]);
  });

  it("packs a Huddler for the button: key, size, then the pixels, little-endian", () => {
    const payload = spritePayload({ key: "hud", width: 2, height: 1, pixels: new Uint16Array([0x5b1c, 0xffff]) });
    assert.deepEqual([...payload], [3, 0x68, 0x75, 0x64, 2, 0, 1, 0, 0x1c, 0x5b, 0xff, 0xff]);
    const frame = encodeFrame("I", payload);
    assert.deepEqual([...frame.subarray(0, 6)], [0x02, 0x49, payload.length, 0, 0, 0]);
    // A full-size Huddler fits in one frame, well under the 64 KB either side accepts.
    assert.ok(spritePayload({ key: "planner", width: 88, height: 88, pixels: new Uint16Array(88 * 88) }).length < 65_536);
  });
});
