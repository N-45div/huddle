import { useEffect, useRef, useState } from "react";
import { api, describeError, type RouterReply } from "../api.ts";
import { ErrorNote } from "../components/bits.tsx";
import { useResource } from "../hooks.ts";
import { AnswerView } from "../views/AnswerView.tsx";
import { Huddler } from "../huddlers/Huddler.tsx";

/**
 * The quick-ask bar (#/quick): what the desktop app opens on its shortcut. One box; Enter asks "auto" (or
 * an assistant you pick) through the router, and the answer comes back, shown as a view when that helps.
 */
export function QuickScreen() {
  const assistants = useResource(() => api.assistants(), []);
  const [model, setModel] = useState("auto");
  const [text, setText] = useState("");
  const [asked, setAsked] = useState("");
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<RouterReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  // Ready to type whenever the window comes back.
  useEffect(() => {
    const focus = () => box.current?.focus();
    focus();
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, []);

  const ask = async () => {
    const question = text.trim();
    if (!question || busy) return;
    setBusy(true);
    setError(null);
    setReply(null);
    setAsked(question);
    try {
      setReply(await api.chat(model, question));
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
          <select id="quick-model" value={model} onChange={(event) => setModel(event.target.value)}>
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
          Asking {model === "auto" ? "whoever fits" : name(model)}…
        </p>
      )}
      {reply && (
        <section className="quick-reply" aria-live="polite">
          <p className="eyebrow reply-who">
            <Huddler id={reply.model} connector={assistants.data?.find((assistant) => assistant.id === reply.model)?.connector} mood="happy" size={30} live />
            {name(reply.model)}
          </p>
          <p className="try-answer">{reply.text}</p>
          <AnswerView key={`${reply.runId}-${reply.text.length}`} text={reply.text} data={reply.data} ask={asked} assistant={name(reply.model)} auto onAsk={(follow) => setText(follow)} />
        </section>
      )}
    </div>
  );
}
