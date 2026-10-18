import { type Change, type Engine, nextRun, type Store } from "@huddle/core";
import type { Hono } from "hono";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import { bearerOf, same } from "./auth.ts";

/**
 * Your gadgets (the Huddle button, or the canvas's virtual one): what each should show, and the yes or no
 * it sends back. A device shows the oldest approval waiting for you, as one line it can say aloud, and
 * takes your answer to it; with nothing waiting, it shows what today has cost, and the next scheduled run.
 * Kept apart from the socket so it can be tested without one.
 */

/** What the device should show now. */
export type Screen =
  | {
      readonly type: "approval";
      readonly id: string;
      readonly flow: string;
      /** One line, short enough for a small screen and to say aloud. */
      readonly line: string;
      readonly message: string;
      /** When the facts in it were checked and some don't match the web. */
      readonly warning: string | null;
      /** How many more are waiting after this one. */
      readonly more: number;
    }
  | {
      readonly type: "idle";
      readonly spentTodayUsd: number;
      readonly nextRun: { readonly flow: string; readonly at: string } | null;
      /** The flows you can start from the button (their trigger is "button"), to pick from. */
      readonly flows: readonly { readonly id: string; readonly name: string }[];
    };

/** Everything a device is sent: the screen, plus a word when a run ends (for its face) and replies. */
export type ToDevice =
  | { readonly type: "hello"; readonly name: string; readonly version: string }
  | Screen
  | {
      readonly type: "run";
      readonly flow: string;
      readonly state: "done" | "failed" | "declined";
      /** For a run a button started: its answer, short enough to show and say. */
      readonly answer: string | null;
    }
  | { readonly type: "answered"; readonly id: string; readonly yes: boolean }
  | { readonly type: "started"; readonly runId: string; readonly flow: string }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "pong" };

const LINE = 90;

/** The first line of an approval's message, on one line, cut at a word to fit a small screen. */
export function oneLine(message: string, max = LINE): string {
  const first = message.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  const flat = first.replace(/\s+/g, " ");
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max / 2)).trimEnd()}…`;
}

interface FromDevice {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly yes?: unknown;
  readonly flow?: unknown;
  readonly input?: unknown;
}

export class DeviceHub {
  private readonly store: Store;
  private readonly engine: Engine;
  private readonly now: () => number;

  constructor(store: Store, engine: Engine, now: () => number = Date.now) {
    this.store = store;
    this.engine = engine;
    this.now = now;
  }

  /** The screen: the oldest approval waiting, else today at a glance. */
  screen(): Screen {
    const waiting = this.store.waitingApprovals();
    const first = waiting[0];
    if (first) {
      const run = this.store.run(first.runId);
      const contradicted = first.checks?.facts.filter((fact) => fact.verdict === "contradicted").length ?? 0;
      return {
        type: "approval",
        id: first.id,
        flow: run?.flow.name ?? "A flow",
        line: oneLine(first.message),
        message: first.message,
        warning: contradicted > 0 ? `${contradicted} ${contradicted === 1 ? "fact doesn't" : "facts don't"} match the web` : null,
        more: waiting.length - 1,
      };
    }
    const start = new Date(this.now());
    start.setHours(0, 0, 0, 0);
    const spentTodayUsd = this.store.spendSince(start.toISOString()).reduce((sum, total) => sum + total.usd, 0);
    let next: { flow: string; at: number } | null = null;
    const flows: { id: string; name: string }[] = [];
    for (const saved of this.store.flows()) {
      if (saved.flow.trigger.type === "button") flows.push({ id: saved.id, name: saved.flow.name });
      if (saved.flow.trigger.type !== "schedule") continue;
      const at = nextRun(saved.flow.trigger, this.now());
      if (!next || at < next.at) next = { flow: saved.flow.name, at };
    }
    return {
      type: "idle",
      spentTodayUsd: Math.round(spentTodayUsd * 1_000_000) / 1_000_000,
      nextRun: next ? { flow: next.flow, at: new Date(next.at).toISOString() } : null,
      flows: flows.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 8),
    };
  }

  /** A button-started run's last answer, as plain words that fit a small screen and a few seconds of speech. */
  answerFor(runId: string): string | null {
    const log = this.store.logOf(runId);
    if (!log.some((line) => line.kind === "started" && (line.detail as { via?: unknown } | null)?.via === "device")) return null;
    const answered = log.findLast((line) => line.kind === "answered");
    const text = (answered?.detail as { text?: unknown } | null)?.text;
    if (typeof text !== "string" || !text.trim()) return null;
    const plain = text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
      .replace(/[*_`#>]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    // The last line of an answer is often its JSON for the flow; the person doesn't need to hear it.
    const words = plain.replace(/\{[^{}]*\}\s*$/, "").trim() || plain;
    return words.length <= 240 ? words : `${words.slice(0, words.lastIndexOf(" ", 239)).trimEnd()}…`;
  }

  /** Starts a button flow for this device: what the person said, else the flow's own input. */
  start(flowId: string, said: string | null, device: string): { readonly runId: string; readonly flow: string } {
    const saved = this.store.flow(flowId);
    if (!saved || saved.flow.trigger.type !== "button") throw new Error("That flow isn't on the button. Give it the button trigger in the canvas.");
    const input = said?.trim() || saved.flow.trigger.input;
    const runId = this.engine.launch(saved.flow, input, saved.id, { name: device, tier: "owner", via: "device" });
    // Words the person said themselves may teach memory (when learning is on); a preset input never does.
    if (said?.trim()) this.engine.learnFrom(runId, said);
    return { runId, flow: saved.flow.name };
  }

  /**
   * A device connected: it's sent the screen now and whenever it changes, a word when a run ends, and the
   * answers to what it sends. Returns what to call with each message it sends, and when it goes.
   */
  connect(send: (message: ToDevice) => void, hello: { readonly name: string; readonly version: string }) {
    let last = "";
    const show = () => {
      const screen = this.screen();
      const key = JSON.stringify(screen);
      if (key === last) return;
      last = key;
      send(screen);
    };
    const finished = new Set<string>();
    const onChange = (change: Change) => {
      if (change.kind === "run") {
        const run = this.store.run(change.runId);
        // Saved flows only: a router chat ending isn't news for the button.
        if (run?.flowId && (run.state === "done" || run.state === "failed" || run.state === "declined") && !finished.has(run.id)) {
          finished.add(run.id);
          send({ type: "run", flow: run.flow.name, state: run.state, answer: this.answerFor(run.id) });
        }
      }
      if (change.kind === "run" || change.kind === "approval" || change.kind === "flow") show();
    };
    send({ type: "hello", ...hello });
    show();
    this.store.events.on("change", onChange);
    // Today's spend and the next run move without a change event: look again each minute.
    const tick = setInterval(show, 60_000);
    tick.unref?.();
    return {
      receive: (text: string) => {
        let message: FromDevice | null;
        try {
          message = JSON.parse(text) as FromDevice | null;
        } catch {
          send({ type: "error", message: "Send JSON." });
          return;
        }
        if (message?.type === "ping") return send({ type: "pong" });
        if (message?.type === "answer" && typeof message.id === "string" && typeof message.yes === "boolean") {
          try {
            this.engine.answer(message.id, message.yes);
            send({ type: "answered", id: message.id, yes: message.yes });
          } catch (error) {
            send({ type: "error", message: error instanceof Error ? error.message : String(error) });
          }
          show();
          return;
        }
        if (message?.type === "start" && typeof message.flow === "string") {
          try {
            const said = typeof message.input === "string" ? message.input.slice(0, 4_000) : null;
            send({ type: "started", ...this.start(message.flow, said, hello.name) });
          } catch (error) {
            send({ type: "error", message: error instanceof Error ? error.message : String(error) });
          }
          return;
        }
        send({ type: "error", message: 'Send { "type": "answer", "id": "...", "yes": true }, { "type": "start", "flow": "..." } or { "type": "ping" }.' });
      },
      close: () => {
        clearInterval(tick);
        this.store.events.off("change", onChange);
      },
    };
  }
}

/**
 * /devices/ws: a device's socket. A device's own token (Settings → Devices), or the Huddle token for the
 * canvas's virtual button, as a Bearer header or ?token= (browsers can't set headers on a WebSocket).
 */
export function deviceRoutes(app: Hono, options: { readonly store: Store; readonly engine: Engine; readonly token?: string; readonly version: string; readonly upgradeWebSocket: UpgradeWebSocket }): DeviceHub {
  const hub = new DeviceHub(options.store, options.engine);
  app.get(
    "/devices/ws",
    async (c, next) => {
      const given = bearerOf(c.req.header("authorization")) ?? c.req.query("token") ?? "";
      const device = given ? options.store.deviceByToken(given) : null;
      if (device || !options.token || same(given, options.token)) {
        c.set("deviceName" as never, (device?.name ?? "Virtual button") as never);
        return next();
      }
      return c.json({ error: "Send a device token, or the Huddle token, as Authorization: Bearer <token> or ?token=." }, 401);
    },
    options.upgradeWebSocket((c) => {
      const name = String(c.get("deviceName" as never) ?? "A device");
      let session: ReturnType<DeviceHub["connect"]> | null = null;
      return {
        onOpen: (_event, socket: WSContext) => {
          session = hub.connect((message) => socket.send(JSON.stringify(message)), { name, version: options.version });
        },
        onMessage: (event) => {
          if (typeof event.data === "string") session?.receive(event.data);
        },
        onClose: () => session?.close(),
        onError: () => session?.close(),
      };
    }),
  );
  return hub;
}
