/**
 * The Huddle button over its USB cable, for when it can't reach Huddle over Wi-Fi (a firewall that needs an
 * administrator, a 5 GHz-only network). The button writes its messages to USB as frames, and this page passes
 * them on to /devices/ws as that button, with the token it announces: Chrome's Web Serial, no driver.
 *
 * A frame is STX (0x02), a kind ('T' JSON text, 'B' 16 kHz PCM), the length (4 bytes, little-endian) and the
 * bytes. Anything between frames is the button's log, line by line.
 */

const STX = 0x02;
const HEAD = 6;
/** Bigger than anything either side sends (64 KB); a header claiming more is noise, not a frame. */
const MAX_FRAME = 1 << 16;
/** Espressif's USB vendor id: the ESP32-S3's own USB port. */
export const ESPRESSIF_VENDOR_ID = 0x303a;
/** Speech to the button: 0.1 s frames, at 16 kHz 16-bit pace, at most half a second ahead of playing. */
const AUDIO_FRAME = 3_200;
const AUDIO_BYTES_PER_MS = 32;
const AUDIO_LEAD = 16_000;
/** With the button's reports: keep 1.5 s queued there, sending at most 0.75 s at a time (its buffer holds ~1 s). */
const AUDIO_TARGET = 48_000;
const AUDIO_BURST = 24_000;

export type UsbEvent =
  | { readonly kind: "line"; readonly text: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "audio"; readonly bytes: Uint8Array }
  /** 'P': a JPEG the button took as you started to talk (on a flow that sees). */
  | { readonly kind: "photo"; readonly bytes: Uint8Array };

/** A picture for the button to keep (an assistant's Huddler), as 16-bit RGB565 pixels, row by row. */
export interface Sprite {
  readonly key: string;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint16Array;
}

/** Bytes as base64, in slices (spreading 50 KB into one call overflows the stack). */
export function base64(bytes: Uint8Array): string {
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}

/** RGBA bytes (a canvas's) as 16-bit RGB565, the button screen's own pixels. */
export function toRgb565(rgba: ArrayLike<number>): Uint16Array {
  const out = new Uint16Array(Math.floor(rgba.length / 4));
  for (let i = 0; i < out.length; i += 1) {
    const r = rgba[i * 4] ?? 0;
    const g = rgba[i * 4 + 1] ?? 0;
    const b = rgba[i * 4 + 2] ?? 0;
    out[i] = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
  }
  return out;
}

/** An 'I' frame's bytes: the key's length and bytes, the width and height (16-bit, little-endian), the pixels. */
export function spritePayload(sprite: Sprite): Uint8Array {
  const key = new TextEncoder().encode(sprite.key.slice(0, 40));
  const out = new Uint8Array(1 + key.length + 4 + sprite.pixels.length * 2);
  const view = new DataView(out.buffer);
  out[0] = key.length;
  out.set(key, 1);
  view.setUint16(1 + key.length, sprite.width, true);
  view.setUint16(3 + key.length, sprite.height, true);
  for (let i = 0; i < sprite.pixels.length; i += 1) view.setUint16(5 + key.length + i * 2, sprite.pixels[i] ?? 0, true);
  return out;
}

export function encodeFrame(kind: "T" | "B" | "I" | "P", payload: Uint8Array | string): Uint8Array {
  const bytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  const frame = new Uint8Array(HEAD + bytes.length);
  frame[0] = STX;
  frame[1] = kind.charCodeAt(0);
  new DataView(frame.buffer).setUint32(2, bytes.length, true);
  frame.set(bytes, HEAD);
  return frame;
}

/** Splits what comes off the cable into log lines and frames, however the bytes are chunked. */
export class FrameReader {
  private pending = new Uint8Array(0);
  private line = "";
  private readonly decoder = new TextDecoder();

  push(chunk: Uint8Array): UsbEvent[] {
    const events: UsbEvent[] = [];
    const all = new Uint8Array(this.pending.length + chunk.length);
    all.set(this.pending);
    all.set(chunk, this.pending.length);
    let at = 0;
    while (at < all.length) {
      const stx = all.indexOf(STX, at);
      this.addText(all.subarray(at, stx < 0 ? all.length : stx), events);
      if (stx < 0) {
        at = all.length;
        break;
      }
      if (all.length - stx < HEAD) {
        at = stx;
        break;
      }
      const kind = String.fromCharCode(all[stx + 1] ?? 0);
      const length = new DataView(all.buffer, all.byteOffset + stx + 2, 4).getUint32(0, true);
      if ((kind !== "T" && kind !== "B" && kind !== "P") || length > MAX_FRAME) {
        at = stx + 1; // not a frame: skip the stray byte
        continue;
      }
      if (all.length - stx - HEAD < length) {
        at = stx;
        break;
      }
      const payload = all.slice(stx + HEAD, stx + HEAD + length);
      events.push(kind === "T" ? { kind: "text", text: this.decoder.decode(payload) } : kind === "P" ? { kind: "photo", bytes: payload } : { kind: "audio", bytes: payload });
      at = stx + HEAD + length;
    }
    this.pending = all.slice(at);
    return events;
  }

  private addText(bytes: Uint8Array, events: UsbEvent[]): void {
    if (!bytes.length) return;
    this.line += this.decoder.decode(bytes, { stream: true });
    const parts = this.line.split("\n");
    this.line = parts.pop() ?? "";
    for (const part of parts) {
      const text = part.replace(/\r$/, "");
      if (text) events.push({ kind: "line", text });
    }
  }
}

// ---- Web Serial, as much of it as this needs (not in TypeScript's DOM types yet) ---------------------------
export interface SerialPortLike {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: { readonly baudRate: number; readonly bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  setSignals?(signals: { readonly dataTerminalReady?: boolean; readonly requestToSend?: boolean }): Promise<void>;
  getInfo(): { readonly usbVendorId?: number; readonly usbProductId?: number };
}

interface SerialLike {
  requestPort(options?: { readonly filters?: readonly { readonly usbVendorId?: number }[] }): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
  /** "connect" when a port this page was allowed is plugged in again. */
  addEventListener(type: "connect" | "disconnect", listener: () => void): void;
}

/** Chrome and Edge on a desktop have Web Serial; other browsers don't. */
export function webSerial(): SerialLike | null {
  return typeof navigator !== "undefined" && "serial" in navigator ? (navigator as Navigator & { serial: SerialLike }).serial : null;
}

export type UsbState = "closed" | "waiting" | "connecting" | "live";

export interface UsbScreen {
  readonly invert: boolean;
  readonly flip: boolean;
}

export interface UsbLinkEvents {
  /** The button's log and this link's own notes, a line at a time. */
  readonly onLine: (line: string, from: "button" | "link") => void;
  readonly onState: (state: UsbState) => void;
  /** The button's speaker volume (0 to 300), as it says when it introduces itself. */
  readonly onVolume?: (volume: number) => void;
  /** How its screen is shown: colours inverted, picture upside down. */
  readonly onScreen?: (screen: UsbScreen) => void;
  /** A photo the button just took, as JPEG bytes. */
  readonly onPhoto?: (jpeg: Uint8Array) => void;
  /** The /devices/ws address for the button's own token. */
  readonly socketUrl: (token: string) => string;
}

/**
 * One button on one port: reads its frames, opens Huddle's device socket with the token it announces, and
 * passes messages both ways. The button announces itself every 2 s until it hears "usb-open", and falls back
 * to waiting when this page stops pinging it.
 */
export class UsbLink {
  private readonly events: UsbLinkEvents;
  private port: SerialPortLike | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private socket: WebSocket | null = null;
  private writing: Promise<void> = Promise.resolve();
  private ping: ReturnType<typeof setInterval> | undefined;
  /** No new socket until this time: after a refusal, not every announcement. */
  private quietUntil = 0;
  /** Huddle's voice for the button, fed at speaking pace (see feedAudio). */
  private audio: Uint8Array[] = [];
  private audioSince = 0;
  private audioSent = 0;
  private audioTimer: ReturnType<typeof setTimeout> | undefined;
  /** The button's last report of speech left to play (bytes), and what's been sent since it. */
  private buffered = 0;
  private sentSinceReport = 0;
  private reportAt = 0;
  private state: UsbState = "closed";

  constructor(events: UsbLinkEvents) {
    this.events = events;
  }

  get current(): UsbState {
    return this.state;
  }

  /** Sets the button's speaker volume (0 to 300); it keeps it, and beeps at the new level. */
  setVolume(volume: number): void {
    this.sendToButton("T", JSON.stringify({ type: "volume", value: Math.round(Math.min(300, Math.max(0, volume))) }));
  }

  /**
   * Sends the button pictures to keep (the Huddlers of your assistants), a few a second: each is about 15 KB
   * and the button's USB buffer holds about 32.
   */
  sendSprites(sprites: readonly Sprite[]): void {
    sprites.forEach((sprite, index) => {
      setTimeout(() => this.sendToButton("I", spritePayload(sprite)), index * 250);
    });
  }

  /** Inverts its screen's colours or turns the picture upside down; it keeps the setting. */
  setScreen(screen: UsbScreen): void {
    this.sendToButton("T", JSON.stringify({ type: "screen", invert: screen.invert, flip: screen.flip }));
  }

  async connect(port: SerialPortLike): Promise<void> {
    await this.disconnect();
    // Room for a second or two of the button's mic; the cable is far faster than 16 kHz audio.
    await port.open({ baudRate: 115_200, bufferSize: 65_536 });
    // DTR up, RTS down: what a serial monitor sends, so opening the port doesn't reset the board.
    await port.setSignals?.({ dataTerminalReady: true, requestToSend: false }).catch(() => undefined);
    if (!port.readable || !port.writable) throw new Error("The port opened but can't be read or written.");
    this.port = port;
    this.writer = port.writable.getWriter();
    this.reader = port.readable.getReader();
    this.setState("waiting");
    this.note("Port open. Waiting for the button to say who it is...");
    // A button still linked to a page that's gone (reloaded, closed) would never say who it is again: tell it
    // the link is closed, so it starts over. Pings only while Huddle is on the line, so a stale link times out.
    this.sendToButton("T", JSON.stringify({ type: "usb-closed" }));
    this.ping = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) this.sendToButton("T", JSON.stringify({ type: "usb-ping" }));
    }, 5_000);
    void this.readLoop(this.reader);
  }

  async disconnect(): Promise<void> {
    clearInterval(this.ping);
    this.ping = undefined;
    clearTimeout(this.audioTimer);
    this.audio = [];
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    // Tell the button right away, instead of letting it wait for pings that won't come.
    if (socket) this.sendToButton("T", JSON.stringify({ type: "usb-closed" }));
    const { reader, writer, port } = this;
    this.reader = null;
    this.writer = null;
    this.port = null;
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
    await this.writing.catch(() => undefined);
    writer?.releaseLock();
    await port?.close().catch(() => undefined);
    this.setState("closed");
  }

  private async readLoop(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const frames = new FrameReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) for (const event of frames.push(value)) this.fromButton(event);
      }
    } catch (error) {
      if (this.reader === reader) this.note(`The cable stopped: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (this.reader === reader) await this.disconnect();
  }

  private fromButton(event: UsbEvent): void {
    if (event.kind === "line") return this.events.onLine(event.text, "button");
    if (event.kind === "photo") {
      this.events.onPhoto?.(event.bytes);
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "photo", jpeg: base64(event.bytes) }));
      return;
    }
    if (event.kind === "audio") {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(event.bytes);
      return;
    }
    this.fromButtonText(event.text);
  }

  /** A JSON message from the button: the link's own (who it is, speech left) or one for Huddle. */
  private fromButtonText(text: string): void {
    let message: { type?: unknown; token?: unknown; volume?: unknown; invert?: unknown; flip?: unknown };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return this.note("The button sent something that isn't JSON; skipped.");
    }
    if (message.type === "usb-buf") {
      // How much speech the button has left to play: top it up from that, not from a timer.
      const ms = (message as { ms?: unknown }).ms;
      if (typeof ms === "number") {
        this.buffered = ms * AUDIO_BYTES_PER_MS;
        this.sentSinceReport = 0;
        this.reportAt = Date.now();
        this.feedAudio();
      }
      return;
    }
    if (message.type === "usb") {
      if (typeof message.volume === "number") this.events.onVolume?.(message.volume);
      if (typeof message.invert === "boolean" && typeof message.flip === "boolean") this.events.onScreen?.({ invert: message.invert, flip: message.flip });
      if (typeof message.token !== "string") return;
      // Announcing while connected means the button restarted (or stopped hearing the pings): start afresh,
      // so Huddle greets it again.
      if (this.socket?.readyState === WebSocket.OPEN) {
        const stale = this.socket;
        this.socket = null;
        stale.close();
        this.note("The button started over; reconnecting it.");
        this.quietUntil = 0;
      }
      if (!this.socket && Date.now() >= this.quietUntil) this.openSocket(message.token);
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(text);
  }

  private openSocket(token: string): void {
    this.setState("connecting");
    this.note("The button said who it is. Connecting it to Huddle...");
    const socket = new WebSocket(this.events.socketUrl(token));
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    let opened = false;
    socket.onopen = () => {
      opened = true;
      this.setState("live");
      this.note("Connected: the button is talking to Huddle.");
      this.sendToButton("T", JSON.stringify({ type: "usb-open" }));
    };
    socket.onmessage = (message) => {
      if (message.data instanceof ArrayBuffer) this.queueAudio(new Uint8Array(message.data));
      else this.sendToButton("T", String(message.data));
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.port) return;
      // Refused straight away is almost always the token: wait a little before trying it again.
      this.quietUntil = Date.now() + (opened ? 1_000 : 10_000);
      this.note(opened ? "Huddle closed the connection; it'll reconnect when the button asks." : "Huddle refused the button. Is its token one Huddle made (Devices, below)?");
      this.sendToButton("T", JSON.stringify({ type: "usb-closed" }));
      this.setState("waiting");
    };
  }

  /**
   * Huddle sends speech as fast as it makes it; the button takes about a second of it in before its USB
   * buffer drops bytes, and a dropped byte scrambles everything after. So the voice goes in 0.1 s frames:
   * topped up to 1.5 s ahead (at most 0.75 s at a time) from the button's own reports of what it has left,
   * which keep coming when Chrome slows a background tab's timers; until the first report, at speaking pace
   * (16 kHz, 16-bit: 32 bytes a millisecond), half a second ahead.
   */
  private queueAudio(bytes: Uint8Array): void {
    for (let at = 0; at < bytes.length; at += AUDIO_FRAME) this.audio.push(bytes.slice(at, at + AUDIO_FRAME));
    this.feedAudio();
  }

  private feedAudio(): void {
    clearTimeout(this.audioTimer);
    this.audioTimer = undefined;
    const now = Date.now();
    // Once everything sent has had time to play, the next speech starts a fresh clock.
    if (this.audioSent <= (now - this.audioSince) * AUDIO_BYTES_PER_MS) {
      this.audioSince = now;
      this.audioSent = 0;
    }
    const reported = now - this.reportAt < 600;
    let room = reported
      ? Math.min(AUDIO_BURST, AUDIO_TARGET - this.buffered - this.sentSinceReport)
      : (now - this.audioSince) * AUDIO_BYTES_PER_MS + AUDIO_LEAD - this.audioSent;
    while (this.audio.length && (this.audio[0]?.length ?? 0) <= room) {
      const frame = this.audio.shift() as Uint8Array;
      this.sendToButton("B", frame);
      this.audioSent += frame.length;
      this.sentSinceReport += frame.length;
      room -= frame.length;
    }
    if (this.audio.length && this.writer) this.audioTimer = setTimeout(() => this.feedAudio(), 25);
  }

  private sendToButton(kind: "T" | "B" | "I", payload: Uint8Array | string): void {
    const writer = this.writer;
    if (!writer) return;
    const frame = encodeFrame(kind, payload);
    this.writing = this.writing.then(() => writer.write(frame)).catch(() => undefined);
  }

  private note(text: string): void {
    this.events.onLine(text, "link");
  }

  private setState(state: UsbState): void {
    this.state = state;
    this.events.onState(state);
  }
}
