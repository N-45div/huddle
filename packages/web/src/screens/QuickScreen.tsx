import { useEffect, useRef, useState } from "react";
import { api, describeError, type RouterReply } from "../api.ts";
import { useApp } from "../app-context.ts";
import { ErrorNote } from "../components/bits.tsx";
import { JustAskResult } from "../components/JustAskResult.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { useResource } from "../hooks.ts";
import type { AskReply } from "../types.ts";
import { AnswerView } from "../views/AnswerView.tsx";
import { Huddler } from "../huddlers/Huddler.tsx";

/** The first choice, when the server has a model to plan with: Just ask. */
const JUST_ASK = "just-ask";

/**
 * The quick-ask bar (#/quick): what the desktop app opens on its shortcut. One box; Enter hands it to Just ask
 * (Huddle works out which flow, assistant or team does it), or asks "auto" or an assistant you pick through the
 * router, and the answer comes back, shown as a view when that helps.
 */
export function QuickScreen() {
  const { info } = useApp();
  const assistants = useResource(() => api.assistants(), []);
  const [model, setModel] = useState(JUST_ASK);
  const [text, setText] = useState("");
  const [asked, setAsked] = useState("");
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<RouterReply | null>(null);
  const [planned, setPlanned] = useState<AskReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Just ask only when the server can plan; else "auto" through the router, as before.
  const picked = model === JUST_ASK && !info?.justAsk ? "auto" : model;
  const box = useRef<HTMLTextAreaElement>(null);

  // Ready to type whenever the window comes back, with the assistants as they are now.
  useEffect(() => {
    const focus = () => {
      box.current?.focus();
      void assistants.reload();
    };
    focus();
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ask = async () => {
    const question = text.trim();
    if (!question || busy) return;
    setBusy(true);
    setError(null);
    setReply(null);
    setPlanned(null);
    setAsked(question);
    try {
      if (picked === JUST_ASK) setPlanned(await api.ask(question));
      else setReply(await api.chat(picked, question));
      setText("");
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const name = (id: string) => assistants.data?.find((assistant) => assistant.id === id)?.name ?? id;

  return (
    <div className="quick">
      <form
        className="quick-form"
        onSubmit={(event) => {
          event.preventDefault();
          void ask();
        }}
      >
        <label className="visually-hidden" htmlFor="quick-text">
          Ask your assistants
        </label>
        <textarea
          id="quick-text"
          ref={box}
          rows={2}
          value={text}
          placeholder="Ask your assistants…"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void ask();
            }
          }}
        />
        <div className="quick-bar">
          <label className="visually-hidden" htmlFor="quick-model">
            Who answers
          </label>
          <select id="quick-model" value={picked} onChange={(event) => setModel(event.target.value)}>
            {info?.justAsk && <option value={JUST_ASK}>Just ask (Huddle picks the team)</option>}
            <option value="auto">Auto</option>
            {(assistants.data ?? [])
              .filter((assistant) => assistant.connector !== "email")
              .map((assistant) => (
                <option key={assistant.id} value={assistant.id}>
                  {assistant.name ?? assistant.id}
                </option>
              ))}
          </select>
          <span className="hint">Enter to ask · Shift+Enter for a new line</span>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !text.trim()}>
            {busy ? "Asking…" : "Ask"}
          </button>
        </div>
      </form>
      {error && <ErrorNote message={error} />}
      {busy && (
        <p className="hint view-busy" role="status">
          <Huddler mood="thinking" size={34} live />
          {picked === JUST_ASK ? "Working out who does it…" : `Asking ${picked === "auto" ? "whoever fits" : name(picked)}…`}
        </p>
      )}
      {planned && <JustAskResult key={planned.run?.runId ?? planned.answer?.runId ?? asked} asked={planned} question={asked} onAsk={(follow) => setText(follow)} />}
      {reply && (
        <section className="quick-reply" aria-live="polite">
          <p className="eyebrow reply-who">
            <Huddler id={reply.model} connector={assistants.data?.find((assistant) => assistant.id === reply.model)?.connector} mood="happy" size={30} live />
            {name(reply.model)}
          </p>
          <Markdown className="try-answer" text={reply.text} />
          <AnswerView key={`${reply.runId}-${reply.text.length}`} text={reply.text} data={reply.data} ask={asked} assistant={name(reply.model)} auto onAsk={(follow) => setText(follow)} />
        </section>
      )}
    </div>
  );
}
