import { useEffect, useRef, useState } from "react";
import { api, describeError, deviceSocketUrl } from "../api.ts";
import { useApp } from "../app-context.ts";
import { Empty, ErrorNote, Hint, Icon, Loading } from "../components/bits.tsx";
import { useChanges } from "../events.ts";
import { ago, dollars, fullTime } from "../format.ts";
import { useResource } from "../hooks.ts";
import { Huddler } from "../huddlers/Huddler.tsx";
import type { Mood } from "../huddlers/huddler.ts";
import type { Device, DeviceMessage } from "../types.ts";
import { TokenRow } from "./ContactsScreen.tsx";

type Screen = Extract<DeviceMessage, { type: "approval" } | { type: "idle" }>;
const SPEAK_KEY = "huddle.button.speak";

/**
 * Your gadgets: the Huddle button on your desk, and this virtual one, which talks to Huddle the same
 * way. It shows the oldest approval waiting for you as one line (and can say it aloud), takes your yes
 * or no, and with nothing waiting, starts the flows you've put on the button.
 */
export function DevicesScreen() {
  return (
    <div className="page page-narrow">
      <header className="page-head">
        <div>
          <h1>Devices</h1>
          <p className="lede">The Huddle button shows what's waiting for you, takes your yes or no, and starts the flows you put on it. This one works the same, in the browser.</p>
        </div>
      </header>
      <VirtualButton />
      <YourDevices />
    </div>
  );
}

function VirtualButton() {
  const { authVersion } = useApp();
  const [link, setLink] = useState<"connecting" | "live" | "offline">("connecting");
  const [screen, setScreen] = useState<Screen | null>(null);
  const [mood, setMood] = useState<Mood>("idle");
  const [note, setNote] = useState<string | null>(null);
  const [speak, setSpeak] = useState(() => {
    try {
      return localStorage.getItem(SPEAK_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [picked, setPicked] = useState("");
  const [said, setSaid] = useState("");
  /** A button run's answer, on the screen for a while, as the gadget shows it. */
  const [reply, setReply] = useState<{ readonly flow: string; readonly text: string } | null>(null);
  const replyTimer = useRef<number | undefined>(undefined);
  const socket = useRef<WebSocket | null>(null);
  const speakRef = useRef(speak);
  const spoken = useRef<string | null>(null);
  const moodTimer = useRef<number | undefined>(undefined);
  speakRef.current = speak;

  useEffect(() => {
    let closed = false;
    let retry = 1_000;
    let timer: number | undefined;
    const say = (text: string) => {
      if (!speakRef.current || !("speechSynthesis" in window)) return;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    };
    const flash = (next: Mood) => {
      setMood(next);
      window.clearTimeout(moodTimer.current);
      moodTimer.current = window.setTimeout(() => setMood((current) => (current === next ? "idle" : current)), 4_000);
    };
    const handle = (message: DeviceMessage) => {
      if (message.type === "approval") {
        setScreen(message);
        setMood("waiting");
        if (spoken.current !== message.id) {
          spoken.current = message.id;
          say(`${message.flow}. ${message.line}${message.warning ? ` Careful: ${message.warning}.` : ""}`);
        }
      } else if (message.type === "idle") {
        setScreen(message);
        setMood((current) => (current === "waiting" ? "idle" : current));
      } else if (message.type === "run") {
        flash(message.state === "failed" ? "oops" : message.state === "done" ? "happy" : "idle");
        if (message.answer) {
          setReply({ flow: message.flow, text: message.answer });
          say(message.answer);
          window.clearTimeout(replyTimer.current);
          replyTimer.current = window.setTimeout(() => setReply(null), 15_000);
        }
        setNote(`${message.flow}: ${message.state === "done" ? "done" : message.state === "failed" ? "failed" : "stopped"}`);
      } else if (message.type === "answered") {
        setNote(message.yes ? "Approved." : "Declined.");
      } else if (message.type === "started") {
        setNote(`Started ${message.flow}.`);
        setSaid("");
      } else if (message.type === "error") {
        setNote(message.message);
        flash("oops");
      }
    };
    const open = () => {
      const ws = new WebSocket(deviceSocketUrl());
      socket.current = ws;
      setLink("connecting");
      ws.onopen = () => {
        setLink("live");
        retry = 1_000;
      };
      ws.onmessage = (event) => {
        try {
          handle(JSON.parse(String(event.data)) as DeviceMessage);
        } catch {
          // Not a message this page knows; the next screen will come.
        }
      };
      ws.onclose = () => {
        socket.current = null;
        if (closed) return;
        setLink("offline");
        timer = window.setTimeout(open, retry);
        retry = Math.min(retry * 2, 15_000);
      };
    };
    open();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      window.clearTimeout(moodTimer.current);
      window.clearTimeout(replyTimer.current);
      socket.current?.close();
    };
  }, [authVersion]);

  const send = (message: unknown) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
    else setNote("Not connected yet.");
  };

  const toggleSpeak = (on: boolean) => {
    setSpeak(on);
    try {
      localStorage.setItem(SPEAK_KEY, on ? "1" : "0");
    } catch {
      // Not remembered in this browser; it still works now.
    }
  };

  const flows = screen?.type === "idle" ? screen.flows : [];
  const chosen = flows.find((flow) => flow.id === picked) ?? flows[0];

  return (
    <section className="card gadget-card" aria-labelledby="virtual-title">
      <div className="tidy-head">
        <div>
          <h2 className="card-title" id="virtual-title">
            Virtual button
          </h2>
          <p className="hint">
            {link === "live" ? "Connected, the same way the real one is." : link === "connecting" ? "Connecting…" : "Offline, retrying."}
          </p>
        </div>
        <label className="switch">
          <input type="checkbox" role="switch" checked={speak} onChange={(event) => toggleSpeak(event.target.checked)} />
          <span>Say it aloud</span>
        </label>
      </div>

      <div className="gadget">
        <div className="gadget-screen" aria-live="polite">
          <Huddler mood={mood} size={64} live />
          {!screen && <p className="gadget-line">…</p>}
          {screen?.type === "approval" && (
            <>
              <p className="gadget-flow">{screen.flow}</p>
              <p className="gadget-line">{screen.line}</p>
              {screen.warning && <p className="gadget-warn">{screen.warning}</p>}
              {screen.more > 0 && <p className="gadget-meta">+{screen.more} more waiting</p>}
            </>
          )}
          {screen?.type === "idle" && reply && (
            <>
              <p className="gadget-flow">{reply.flow}</p>
              <p className="gadget-reply">{reply.text}</p>
            </>
          )}
          {screen?.type === "idle" && !reply && (
            <>
              <p className="gadget-line">Nothing needs you.</p>
              <p className="gadget-meta">Today: {dollars(screen.spentTodayUsd)}</p>
              {screen.nextRun && (
                <p className="gadget-meta">
                  Next: {screen.nextRun.flow},{" "}
                  <time dateTime={screen.nextRun.at} title={fullTime(screen.nextRun.at)}>
                    {new Date(screen.nextRun.at).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}
                  </time>
                </p>
              )}
            </>
          )}
        </div>
        {note && (
          <p className="gadget-note" role="status">
            {note}
          </p>
        )}
      </div>

      {screen?.type === "approval" && (
        <div className="gadget-actions">
          <button type="button" className="btn btn-primary" onClick={() => send({ type: "answer", id: screen.id, yes: true })}>
            Yes <span className="muted">(press)</span>
          </button>
          <button type="button" className="btn" onClick={() => send({ type: "answer", id: screen.id, yes: false })}>
            No <span className="muted">(hold)</span>
          </button>
        </div>
      )}

      {screen?.type === "idle" &&
        (flows.length === 0 ? (
          <Hint>No flows on the button yet. In a flow's Trigger tab, pick “From my Huddle button”.</Hint>
        ) : (
          <form
            className="gadget-start"
            onSubmit={(event) => {
              event.preventDefault();
              if (chosen) send({ type: "start", flow: chosen.id, ...(said.trim() ? { input: said.trim() } : {}) });
            }}
          >
            <div className="field">
              <label htmlFor="button-flow">Start</label>
              <select id="button-flow" value={chosen?.id ?? ""} onChange={(event) => setPicked(event.target.value)}>
                {flows.map((flow) => (
                  <option key={flow.id} value={flow.id}>
                    {flow.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field field-grow">
              <label htmlFor="button-said">What you'd say holding it (optional)</label>
              <input id="button-said" value={said} autoComplete="off" onChange={(event) => setSaid(event.target.value)} />
            </div>
            <button type="submit" className="btn btn-primary">
              Start
            </button>
          </form>
        ))}
    </section>
  );
}

function YourDevices() {
  const { authVersion } = useApp();
  const devices = useResource(() => api.devices(), [authVersion]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ readonly name: string; readonly token: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  useChanges((change) => {
    if (change.kind === "devices" || change.kind === "resync") void devices.reload();
  });

  const add = async () => {
    if (!name.trim()) return setError("Give it a name, like “Desk button”.");
    setBusy(true);
    setError(null);
    try {
      const made = await api.addDevice(name.trim());
      setFresh({ name: made.device.name, token: made.token });
      setName("");
      void devices.reload();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const address = deviceSocketUrl().replace(/\?.*$/, "");
  return (
    <section className="devices" aria-labelledby="devices-title">
      <h2 id="devices-title" className="section-title">
        Your devices
      </h2>
      {fresh && (
        <section className="card token-card" aria-live="polite">
          <p className="eyebrow">{fresh.name}'s token</p>
          <TokenRow token={fresh.token} />
          <p className="hint">
            Copy it now: Huddle keeps only a fingerprint and can't show it again. Put it in the button's settings with your Wi-Fi and this address: <code>{address}</code>
          </p>
        </section>
      )}
      <form
        className="card add-device"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <div className="field field-grow">
          <label htmlFor="device-name">Name</label>
          <input id="device-name" value={name} placeholder="Desk button" autoComplete="off" onChange={(event) => setName(event.target.value)} />
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          <Icon name="plus" /> {busy ? "Adding…" : "Add and make a token"}
        </button>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </form>
      {devices.error && <ErrorNote message={devices.error} onRetry={() => void devices.reload()} />}
      {devices.loading && !devices.data && <Loading label="Loading devices…" />}
      {devices.data && devices.data.length === 0 && (
        <Empty title="No devices yet.">
          <p className="hint">Add one for the Huddle button, then put its token in the button's settings.</p>
        </Empty>
      )}
      {devices.data && devices.data.length > 0 && (
        <ul className="note-list">
          {devices.data.map((device: Device) => (
            <li key={device.id} className="note-item">
              <div className="note-text">
                <p>{device.name}</p>
                <p className="note-meta">{device.lastSeenAt ? <>Last connected {ago(device.lastSeenAt)}</> : "Hasn't connected yet"}</p>
              </div>
              <div className="note-actions">
                {removing === device.id ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger-solid"
                      onClick={() =>
                        void api.removeDevice(device.id).then(
                          () => {
                            setRemoving(null);
                            void devices.reload();
                          },
                          (caught: unknown) => setError(describeError(caught)),
                        )
                      }
                    >
                      Remove
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRemoving(null)}>
                      Keep
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn btn-sm btn-ghost danger-text" onClick={() => setRemoving(device.id)}>
                    Remove
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
