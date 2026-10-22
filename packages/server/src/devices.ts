import { AUTO, type Change, type Engine, type Flow, nextRun, type Router, SAMPLE_RATE, sentences, type Speech, spokenForm, type Store } from "@huddle/core";
import type { Hono } from "hono";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import { bearerOf, same } from "./auth.ts";

/**
 * Your gadgets (the Huddle button, or the canvas's virtual one): what each should show, and what it sends
 * back. A device shows the oldest approval waiting for you, as one line, and takes your yes or no; with
 * nothing waiting, it shows today at a glance and the flows you've put on the button. With speech set up
 * (NVIDIA's NeMo-Speech on this machine), it also says the line and the answers aloud, and you can hold it
 * and talk: your words start the chosen flow, or go to the router. Audio goes to the local speech server
 * only. Kept apart from the socket so it can be tested without one.
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
      /** `label` is `at` in this machine's own time, ready to show ("Fri 6:00 PM"): a gadget has no time zone. */
      readonly nextRun: { readonly flow: string; readonly at: string; readonly label: string } | null;
      /** The flows you can start from the button (their trigger is "button"), to pick from. */
      readonly flows: readonly { readonly id: string; readonly name: string }[];
    };

/** Everything a device is sent (as JSON), besides the audio (binary frames between "speaking" and "spoken"). */
export type ToDevice =
  | { readonly type: "hello"; readonly name: string; readonly version: string; readonly speech: boolean }
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
  /** What it heard you say, once the speech server has listened. */
  | { readonly type: "heard"; readonly text: string }
  /** 16-bit mono PCM at sampleRate follows, in binary frames, then "spoken". */
  | { readonly type: "speaking"; readonly text: string; readonly sampleRate: number; readonly bytes: number }
  | { readonly type: "spoken" }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "pong" };

const LINE = 90;
/** The most a device may say in one go: 30 seconds of 16 kHz 16-bit audio. */
const MAX_LISTEN_BYTES = 30 * SAMPLE_RATE * 2;
const AUDIO_FRAME = 4_096;
/** When the next scheduled run is, in this machine's time zone. */
const NEXT_RUN_LABEL = new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });

/** The first line of an approval's message, on one line, cut at a word to fit a small screen. */
export function oneLine(message: string, max = LINE): string {
  const first = message.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  const flat = first.replace(/\s+/g, " ");
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max / 2)).trimEnd()}…`;
}

/**
 * An answer as plain words that fit a small screen and a few seconds of speech: whole sentences when they
 * fit, so it never stops mid-sentence, else cut at a word.
 */
export function shortAnswer(text: string, max = 300): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // The last line of an answer is often its JSON for the flow; the person doesn't need to hear it.
  const words = plain.replace(/\{[^{}]*\}\s*$/, "").trim() || plain;
  if (words.length <= max) return words;
  const head = words.slice(0, max);
  const sentenceEnd = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (sentenceEnd >= max / 3) return head.slice(0, sentenceEnd + 1);
  return `${words.slice(0, words.lastIndexOf(" ", max - 1)).trimEnd()}…`;
}

/**
 * What a run started by voice tells its answering assistant: it speaks as Hud, Huddle's own, in a few spoken
 * sentences. It goes into that step's ask (so the run's log shows it), never into the saved flow.
 */
export const VOICE_NOTE =
  "You were asked this out loud, through Hud, the Huddle button on the person's desk, and your answer is spoken back. " +
  "Speak as Hud: Huddle's own assistant, a small, friendly robot. Huddle runs the person's AI assistants as one team on their own computer: " +
  "it passes work between them, remembers what the person tells it, and asks them before anything that spends, sends or books (on this button, they hold it to say yes). " +
  "If they ask who or what you are, say you're Hud, from Huddle, and what Huddle does, and never claim to do anything it doesn't. " +
  "Answer in one to three short sentences, the way you'd say it: no lists, no markdown, nothing that only reads well on a screen.";

/** A saved flow as a voice run asks it: its last assistant step (the one whose answer is said) gets VOICE_NOTE. */
export function asSpoken(flow: Flow): Flow {
  const last = flow.steps.findLast((step) => step.type === "agent");
  if (!last || last.type !== "agent") return flow;
  return { ...flow, steps: flow.steps.map((step) => (step === last ? { ...last, ask: `${VOICE_NOTE}\n\n${last.ask}` } : step)) };
}

/**
 * Text cut into what is said in one go: whole sentences, joined until they're long enough that the next part
 * is ready before this one has been said (a short "Hello!" alone leaves a gap while the next is made).
 */
export function spokenParts(text: string, least = 90): string[] {
  const parts: string[] = [];
  for (const sentence of sentences(spokenForm(text))) {
    const previous = parts.at(-1);
    if (previous !== undefined && previous.length < least && previous.length + sentence.length < 220) parts[parts.length - 1] = `${previous} ${sentence}`;
    else parts.push(sentence);
  }
  return parts;
}

interface FromDevice {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly yes?: unknown;
  readonly flow?: unknown;
  readonly input?: unknown;
  readonly audio?: unknown;
}

export interface DeviceHubOptions {
  readonly now?: () => number;
  /** Listening and speaking, on this machine; without it, the button shows text only. */
  readonly speech?: Speech;
  /** Where a spoken ask goes when no flow is picked. */
  readonly router?: Router;
}

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class DeviceHub {
  private readonly store: Store;
  private readonly engine: Engine;
  private readonly now: () => number;
  readonly speech: Speech | null;
  private readonly router: Router | null;

  constructor(store: Store, engine: Engine, options: DeviceHubOptions = {}) {
    this.store = store;
    this.engine = engine;
    this.now = options.now ?? Date.now;
    this.speech = options.speech ?? null;
    this.router = options.router ?? null;
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
    flows.sort((a, b) => a.name.localeCompare(b.name));
    return {
      type: "idle",
      spentTodayUsd: Math.round(spentTodayUsd * 1_000_000) / 1_000_000,
      nextRun: next ? { flow: next.flow, at: new Date(next.at).toISOString(), label: NEXT_RUN_LABEL.format(next.at) } : null,
      flows: flows.slice(0, 8),
    };
  }

  /** A button-started run's last answer, short; null for runs a button didn't start. */
  answerFor(runId: string): string | null {
    const log = this.store.logOf(runId);
    if (!log.some((line) => line.kind === "started" && (line.detail as { via?: unknown } | null)?.via === "device")) return null;
    const text = (log.findLast((line) => line.kind === "answered")?.detail as { text?: unknown } | null)?.text;
    return typeof text === "string" && text.trim() ? shortAnswer(text) : null;
  }

  /** Starts a button flow for this device: what the person said, else the flow's own input. */
  start(flowId: string, said: string | null, device: string): { readonly runId: string; readonly flow: string } {
    const saved = this.store.flow(flowId);
    if (!saved || saved.flow.trigger.type !== "button") throw new Error("That flow isn't on the button. Give it the button trigger in the canvas.");
    const input = said?.trim() || saved.flow.trigger.input;
    // Said out loud, it's answered out loud: as Hud, briefly.
    const flow = said?.trim() ? asSpoken(saved.flow) : saved.flow;
    const runId = this.engine.launch(flow, input, saved.id, { name: device, tier: "owner", via: "device" });
    // Words the person said themselves may teach memory (when learning is on); a preset input never does.
    if (said?.trim()) this.engine.learnFrom(runId, said);
    return { runId, flow: saved.flow.name };
  }

  /** Notes on a run that its input was spoken, and heard on this machine: the run's receipt shows it. */
  private heard(runId: string, text: string, bytes: number): void {
    this.store.log(runId, "voice", "heard", { by: this.speech?.name ?? "speech", local: true, seconds: Math.round((bytes / (SAMPLE_RATE * 2)) * 10) / 10, chars: text.length });
  }

  /**
   * A device connected: it's sent the screen now and whenever it changes, a word when a run ends, the
   * answers to what it sends, and (when it says it plays audio and speech is set up) speech. Returns what
   * to call with each message and audio frame it sends, and when it goes.
   */
  connect(send: (message: ToDevice) => void, hello: { readonly name: string; readonly version: string }, sendAudio?: (chunk: Uint8Array<ArrayBuffer>) => void) {
    let last = "";
    let spokenApproval: string | null = null;
    let playsAudio = false;
    let generation = 0;
    let listening: { flow: string | null; chunks: Uint8Array[]; bytes: number } | null = null;

    /** Says text in spoken form, a sentence at a time; something newer to say cuts it short. */
    const say = async (text: string) => {
      const speech = this.speech;
      if (!speech || !playsAudio || !sendAudio || !text.trim()) return;
      const mine = ++generation;
      for (const part of spokenParts(text)) {
        let pcm: Uint8Array<ArrayBuffer>;
        try {
          pcm = await speech.speak(part);
        } catch (error) {
          send({ type: "error", message: failure(error) });
          return;
        }
        if (mine !== generation) return;
        send({ type: "speaking", text: part, sampleRate: SAMPLE_RATE, bytes: pcm.byteLength });
        for (let offset = 0; offset < pcm.byteLength; offset += AUDIO_FRAME) sendAudio(pcm.subarray(offset, offset + AUDIO_FRAME));
        send({ type: "spoken" });
      }
    };

    const show = () => {
      const screen = this.screen();
      const key = JSON.stringify(screen);
      if (key === last) return;
      last = key;
      send(screen);
      if (screen.type === "approval" && screen.id !== spokenApproval) {
        spokenApproval = screen.id;
        void say(`${screen.flow}. ${screen.line}${screen.warning ? ` Careful: ${screen.warning}.` : ""}`);
      }
    };

    const finished = new Set<string>();
    const onChange = (change: Change) => {
      if (change.kind === "run") {
        const run = this.store.run(change.runId);
        // Saved flows only: a router chat ending isn't news for the button.
        if (run?.flowId && (run.state === "done" || run.state === "failed" || run.state === "declined") && !finished.has(run.id)) {
          finished.add(run.id);
          const answer = this.answerFor(run.id);
          send({ type: "run", flow: run.flow.name, state: run.state, answer });
          if (answer) void say(answer);
        }
      }
      if (change.kind === "run" || change.kind === "approval" || change.kind === "flow") show();
    };

    /** The device stopped talking: hear it, then start its flow, or ask the router and say the answer. */
    const heard = async (turn: { flow: string | null; chunks: Uint8Array[]; bytes: number }) => {
      const speech = this.speech;
      if (!speech) return send({ type: "error", message: "Voice isn't set up here: run NVIDIA NeMo-Speech and set HUDDLE_SPEECH_URL." });
      const pcm = new Uint8Array(turn.bytes);
      let offset = 0;
      for (const chunk of turn.chunks) {
        pcm.set(chunk, offset);
        offset += chunk.byteLength;
      }
      let text: string;
      try {
        text = await speech.transcribe(pcm);
      } catch (error) {
        return send({ type: "error", message: failure(error) });
      }
      send({ type: "heard", text });
      if (!text) return void say("Sorry, I didn't catch that.");
      try {
        if (turn.flow) {
          const started = this.start(turn.flow, text, hello.name);
          this.heard(started.runId, text, pcm.byteLength);
          send({ type: "started", ...started });
          return;
        }
        if (!this.router) return send({ type: "error", message: "Pick a flow on the button to start with your words." });
        const routed = await this.router.answer({ model: AUTO, ask: `${VOICE_NOTE}\n\n${text}` });
        this.heard(routed.runId, text, pcm.byteLength);
        this.engine.learnFrom(routed.runId, text);
        const answer = shortAnswer(routed.text);
        send({ type: "run", flow: `Asked ${routed.assistant.name ?? routed.assistant.id}`, state: "done", answer });
        void say(answer);
      } catch (error) {
        send({ type: "error", message: failure(error) });
      }
    };

    send({ type: "hello", ...hello, speech: this.speech !== null });
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
        switch (message?.type) {
          case "ping":
            return send({ type: "pong" });
          case "hello":
            // The device says whether it plays audio; the virtual button does when you ask it to.
            playsAudio = message.audio === true;
            if (!playsAudio) generation++;
            return;
          case "answer":
            if (typeof message.id !== "string" || typeof message.yes !== "boolean") break;
            generation++; // stop saying the line: it's been answered
            try {
              this.engine.answer(message.id, message.yes);
              send({ type: "answered", id: message.id, yes: message.yes });
            } catch (error) {
              send({ type: "error", message: failure(error) });
            }
            show();
            return;
          case "start":
            if (typeof message.flow !== "string") break;
            try {
              const said = typeof message.input === "string" ? message.input.slice(0, 4_000) : null;
              send({ type: "started", ...this.start(message.flow, said, hello.name) });
            } catch (error) {
              send({ type: "error", message: failure(error) });
            }
            return;
          case "listen":
            generation++; // you're talking: stop speaking
            listening = { flow: typeof message.flow === "string" ? message.flow : null, chunks: [], bytes: 0 };
            return;
          case "stop": {
            const turn = listening;
            listening = null;
            if (turn) void heard(turn);
            return;
          }
        }
        send({ type: "error", message: 'Send "answer", "start", "listen" then audio then "stop", "hello" or "ping".' });
      },
      /** Audio while listening: 16 kHz mono 16-bit PCM. */
      receiveAudio: (chunk: Uint8Array) => {
        if (!listening || listening.bytes + chunk.byteLength > MAX_LISTEN_BYTES) return;
        listening.chunks.push(chunk.slice());
        listening.bytes += chunk.byteLength;
      },
      close: () => {
        generation++;
        clearInterval(tick);
        this.store.events.off("change", onChange);
      },
    };
  }
}

/**
 * A device can drop off mid-handshake (power or Wi-Fi gone); the socket's error then has no listener until
 * the WebSocket takes it over, and an unhandled socket error stops the whole server. Every upgrading
 * socket gets one at once.
 */
export function guardUpgrades(server: { on(event: "upgrade", listener: (request: unknown, socket: { on(event: "error", listener: () => void): unknown }) => void): unknown }): void {
  server.on("upgrade", (_request, socket) => {
    socket.on("error", () => undefined);
  });
}

/**
 * /devices/ws: a device's socket. A device's own token (Devices in the canvas), or the Huddle token for the
 * canvas's virtual button, as a Bearer header or ?token= (browsers can't set headers on a WebSocket).
 */
export function deviceRoutes(
  app: Hono,
  options: { readonly store: Store; readonly engine: Engine; readonly token?: string; readonly version: string; readonly upgradeWebSocket: UpgradeWebSocket; readonly speech?: Speech; readonly router?: Router },
): DeviceHub {
  const hub = new DeviceHub(options.store, options.engine, { ...(options.speech ? { speech: options.speech } : {}), ...(options.router ? { router: options.router } : {}) });
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
          session = hub.connect(
            (message) => socket.send(JSON.stringify(message)),
            { name, version: options.version },
            (chunk) => socket.send(chunk),
          );
        },
        onMessage: (event) => {
          const data: unknown = event.data;
          if (typeof data === "string") session?.receive(data);
          else if (data instanceof Uint8Array) session?.receiveAudio(data);
          else if (data instanceof ArrayBuffer) session?.receiveAudio(new Uint8Array(data));
          else if (data instanceof Blob) void data.arrayBuffer().then((buffer) => session?.receiveAudio(new Uint8Array(buffer)));
        },
        onClose: () => session?.close(),
        onError: () => session?.close(),
      };
    }),
  );
  return hub;
}
