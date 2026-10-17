import { useState } from "react";
import { api, describeError } from "../api.ts";
import { useApp } from "../app-context.ts";
import { useResource } from "../hooks.ts";
import { ErrorNote } from "./bits.tsx";

/** Learning from what you say: off until you turn it on here, and it says plainly who reads your words. */
export function Learning() {
  const { authVersion } = useApp();
  const learning = useResource(() => api.learning(), [authVersion]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const turn = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      learning.setData(await api.setLearning(on));
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const view = learning.data;
  if (!view) return null;
  return (
    <section className="card learning" aria-labelledby="learning-title">
      <div className="tidy-head">
        <div>
          <h2 className="card-title" id="learning-title">
            Learn from what you say
          </h2>
          {view.available ? (
            <p className="hint">
              After a flow you run here, or a chat through the router, {view.by} reads what you wrote (not the answers, not your notes) at {view.to} and suggests what's worth remembering about you. Suggestions wait here until you keep them. Mail, webhooks and other people's messages are never read.
            </p>
          ) : (
            <p className="hint">Needs a model: set NEBIUS_API_KEY (or HUDDLE_LLM_URL and HUDDLE_LLM_MODEL) where Huddle runs.</p>
          )}
        </div>
        {view.available && (
          <label className="switch">
            <input type="checkbox" role="switch" checked={view.on} disabled={busy} onChange={(event) => void turn(event.target.checked)} />
            <span>{view.on ? "On" : "Off"}</span>
          </label>
        )}
      </div>
      {error && <ErrorNote message={error} />}
    </section>
  );
}
