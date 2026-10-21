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
/** Bigger than anything the button sends; a header claiming more is noise, not a frame. */
const MAX_FRAME = 1 << 20;
/** Espressif's USB vendor id: the ESP32-S3's own USB port. */
export const ESPRESSIF_VENDOR_ID = 0x303a;

export type UsbEvent =
  | { readonly kind: "line"; readonly text: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "audio"; readonly bytes: Uint8Array };

export function encodeFrame(kind: "T" | "B", payload: Uint8Array | string): Uint8Array {
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
      if ((kind !== "T" && kind !== "B") || length > MAX_FRAME) {
        at = stx + 1; // not a frame: skip the stray byte
        continue;
      }
      if (all.length - stx - HEAD < length) {
        at = stx;
        break;
      }
      const payload = all.slice(stx + HEAD, stx + HEAD + length);
      events.push(kind === "T" ? { kind: "text", text: this.decoder.decode(payload) } : { kind: "audio", bytes: payload });
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
}

/** Chrome and Edge on a desktop have Web Serial; other browsers don't. */
export function webSerial(): SerialLike | null {
  return typeof navigator !== "undefined" && "serial" in navigator ? (navigator as Navigator & { serial: SerialLike }).serial : null;
}

export type UsbState = "closed" | "waiting" | "connecting" | "live";

export interface UsbLinkEvents {
  /** The button's log and this link's own notes, a line at a time. */
  readonly onLine: (line: string, from: "button" | "link") => void;
  readonly onState: (state: UsbState) => void;
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
  private state: UsbState = "closed";

  constructor(events: UsbLinkEvents) {
    this.events = events;
  }

  get current(): UsbState {
    return this.state;
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
    this.ping = setInterval(() => this.sendToButton("T", JSON.stringify({ type: "usb-ping" })), 5_000);
    void this.readLoop(this.reader);
  }

  async disconnect(): Promise<void> {
    clearInterval(this.ping);
    this.ping = undefined;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
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
    if (event.kind === "audio") {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(event.bytes);
      return;
    }
    let message: { type?: unknown; token?: unknown };
    try {
      message = JSON.parse(event.text) as { type?: unknown; token?: unknown };
    } catch {
      return this.note("The button sent something that isn't JSON; skipped.");
    }
    if (message.type === "usb") {
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
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(event.text);
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
      if (message.data instanceof ArrayBuffer) this.sendToButton("B", new Uint8Array(message.data));
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

  private sendToButton(kind: "T" | "B", payload: Uint8Array | string): void {
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
