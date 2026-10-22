import { deviceSocketUrl } from "./api.ts";
import { ESPRESSIF_VENDOR_ID, type SerialPortLike, UsbLink, type UsbState, webSerial } from "./usb-link.ts";

/**
 * The button's USB link for the whole canvas: it stays up while you move between pages (an approval on the
 * button while you watch the run), and the Devices page shows it.
 */
export interface UsbLine {
  readonly id: number;
  readonly text: string;
  readonly from: "button" | "link";
}

export interface UsbSnapshot {
  readonly state: UsbState;
  readonly lines: readonly UsbLine[];
  readonly error: string | null;
}

const KEEP_LINES = 300;
let snapshot: UsbSnapshot = { state: "closed", lines: [], error: null };
let lineId = 0;
const listeners = new Set<() => void>();

function update(next: Partial<UsbSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

const link = new UsbLink({
  onLine: (text, from) => update({ lines: [...snapshot.lines.slice(-(KEEP_LINES - 1)), { id: ++lineId, text, from }] }),
  onState: (state) => update({ state }),
  socketUrl: (token) => {
    const url = new URL(deviceSocketUrl());
    url.searchParams.set("token", token);
    return url.toString();
  },
});

/** Connected by you, and not disconnected by you since: plugging the button back in reconnects it. */
let wanted = false;

async function connect(port: SerialPortLike): Promise<void> {
  update({ error: null });
  try {
    await link.connect(port);
    wanted = true;
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    update({
      error: /open/i.test(said)
        ? "Couldn't open the button's port. Is a serial monitor or an upload using it? Close that, then connect again."
        : `Couldn't connect the button: ${said}`,
    });
  }
}

export const usbSession = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  snapshot: (): UsbSnapshot => snapshot,
  supported: (): boolean => webSerial() !== null,

  /** Asks which port (Chrome lists the ESP32-S3's own USB), then connects it. */
  async choose(): Promise<void> {
    const serial = webSerial();
    if (!serial) return;
    let port: SerialPortLike;
    try {
      port = await serial.requestPort({ filters: [{ usbVendorId: ESPRESSIF_VENDOR_ID }] });
    } catch {
      return; // the chooser was closed without a pick
    }
    await connect(port);
  },

  /** Reconnects a button this browser was allowed before, when there's exactly one. */
  async resume(): Promise<void> {
    const serial = webSerial();
    if (!serial || snapshot.state !== "closed") return;
    const ours = (await serial.getPorts().catch(() => [])).filter((port) => port.getInfo().usbVendorId === ESPRESSIF_VENDOR_ID);
    if (ours.length === 1 && ours[0]) await connect(ours[0]);
  },

  /** Lets go of the port (to flash the button, say); it stays let go until you connect again. */
  disconnect: (): Promise<void> => {
    wanted = false;
    return link.disconnect();
  },
  clearLog: (): void => update({ lines: [] }),
};

// The button unplugged and plugged back in (or restarted by a flash you didn't disconnect for): pick it up
// again once its USB is ready.
webSerial()?.addEventListener("connect", () => {
  if (wanted) setTimeout(() => void usbSession.resume(), 800);
});
