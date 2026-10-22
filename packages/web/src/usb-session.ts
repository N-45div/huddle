import { deviceSocketUrl } from "./api.ts";
import { ESPRESSIF_VENDOR_ID, type SerialPortLike, UsbLink, type UsbScreen, type UsbState, webSerial } from "./usb-link.ts";
import { spritesForButton } from "./usb-sprites.ts";

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
  /** The button's speaker volume (0 to 300), once it has said; null before. */
  readonly volume: number | null;
  /** How its screen is shown, once it has said; null before. */
  readonly screen: UsbScreen | null;
}

const KEEP_LINES = 300;
let snapshot: UsbSnapshot = { state: "closed", lines: [], error: null, volume: null, screen: null };
let lineId = 0;
const listeners = new Set<() => void>();

function update(next: Partial<UsbSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

const link = new UsbLink({
  onLine: (text, from) => update({ lines: [...snapshot.lines.slice(-(KEEP_LINES - 1)), { id: ++lineId, text, from }] }),
  onState: (state) => {
    update({ state });
    // Each time it comes on the line (a restart forgets them), the button gets its Huddlers to draw.
    if (state === "live") {
      spritesForButton().then(
        (sprites) => link.sendSprites(sprites),
        (error: unknown) => update({ error: `Couldn't draw the Huddlers for the button: ${error instanceof Error ? error.message : String(error)}` }),
      );
    }
  },
  onVolume: (volume) => update({ volume }),
  onScreen: (screen) => update({ screen }),
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
  setVolume: (volume: number): void => {
    link.setVolume(volume);
    update({ volume });
  },
  setScreen: (screen: UsbScreen): void => {
    link.setScreen(screen);
    update({ screen });
  },
};

// The button unplugged and plugged back in (or restarted by a flash you didn't disconnect for): pick it up
// again once its USB is ready.
webSerial()?.addEventListener("connect", () => {
  if (wanted) setTimeout(() => void usbSession.resume(), 800);
});
