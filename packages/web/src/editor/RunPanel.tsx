import { useState } from "react";
import { api, describeError } from "../api.ts";
import { useApp } from "../app-context.ts";
import { AnswerButtons } from "../components/Answer.tsx";
import { ErrorNote, Hint, Link, StateBadge } from "../components/bits.tsx";
import { RunLog } from "../components/RunLog.tsx";
import { useChanges } from "../events.ts";
import { ago, fullTime } from "../format.ts";
import { useDebounced, useResource } from "../hooks.ts";
import { href } from "../router.ts";
import type { RunDetail } from "../types.ts";

interface Props {
  readonly flowId: string;
  readonly dirty: boolean;
  readonly watching: string | null;
  readonly detail: RunDetail | null;
  readonly detailError: string | null;
  /** Saves first when there are unsaved changes; throws with a readable message when it can't run. */
  readonly onRun: (input: string, images: readonly string[]) => Promise<void>;
  readonly onWatch: (runId: string | null) => void;
  readonly onAnswered: () => void;
}

export function RunPanel({ flowId, dirty, watching, detail, detailError, onRun, onWatch, onAnswered }: Props) {
  const { authVersion } = useApp();
  const [input, setInput] = useState("");
  /** Photos to start the run with, as data: URLs; only assistants allowed to see images get them. */
  const [photos, setPhotos] = useState<readonly { readonly name: string; readonly url: string }[]>([]);
  const addPhotos = async (files: FileList | null) => {
    const picked = [...(files ?? [])].filter((file) => /^image\/(png|jpeg|webp|gif)$/.test(file.type));
    const tooBig = picked.find((file) => file.size > 5 * 1024 * 1024);
    if (tooBig) return setError(`${tooBig.name} is over 5 MB.`);
    const read = await Promise.all(picked.map((file) => new Promise<{ name: string; url: string }>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve({ name: file.name, url: String(reader.result) }); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); })));
    setPhotos((current) => [...current, ...read].slice(0, 4));
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recent = useResource(() => api.runs({ flow: flowId, limit: 8 }), [flowId, authVersion]);
  const refetchRecent = useDebounced(() => void recent.reload(), 300);

  useChanges((change) => {
    if (change.kind === "run" || change.kind === "approval" || change.kind === "resync") refetchRecent();
  });

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onRun(input, photos.map((photo) => photo.url));
      setPhotos([]);
      refetchRecent();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const current = detail && detail.run.id === watching ? detail : null;

  return (
    <div className="inspector-section">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <div className="field">
          <label htmlFor="run-input">Input</label>
          <textarea id="run-input" rows={4} value={input} aria-describedby="run-input-hint" onChange={(event) => setInput(event.target.value)} />
          <Hint id="run-input-hint">
            Steps read it as <code>{"{{input}}"}</code>.
          </Hint>
        </div>
        <div className="field">
          <label htmlFor="run-photos">Photos (optional)</label>
          <input id="run-photos" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple aria-describedby="run-photos-hint" onChange={(event) => { void addPhotos(event.target.files); event.target.value = ""; }} />
          {photos.length > 0 && (
            <ul className="run-photos">
              {photos.map((photo, index) => (
                <li key={`${photo.name}-${index}`}>
                  <img src={photo.url} alt={photo.name} />
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPhotos((current) => current.filter((_, other) => other !== index))}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Hint id="run-photos-hint">Up to 4. Only assistants allowed to see photos get them, like a Nemotron VL reader.</Hint>
        </div>
        {dirty && <p className="note note-soft">You have unsaved changes. Running saves them first.</p>}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="form-foot">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Starting…" : dirty ? "Save and run" : "Run"}
          </button>
        </div>
      </form>

      {watching && (
        <section className="live-run" aria-live="polite" aria-label="This run">
          <div className="live-head">
            {current ? <StateBadge state={current.run.state} /> : <span className="hint">Loading the run…</span>}
            <Link to={href.run(watching)} className="btn btn-sm btn-ghost">
              Open in Runs
            </Link>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => onWatch(null)}>
              Clear
            </button>
          </div>
          {detailError && <ErrorNote message={detailError} />}
          {current && (
            <>
              <ul className="legend" aria-label="What the colours on the canvas mean">
                <li className="run-done">Done</li>
                <li className="run-current">Working</li>
                <li className="run-waiting">Waiting</li>
                <li className="run-failed">Failed</li>
              </ul>
              {current.run.state === "waiting" && current.run.waiting && (
                <div className="card waiting-card">
                  <p className="eyebrow">Waiting for you</p>
                  <p className="waiting-message">{current.run.waiting.message}</p>
                  <AnswerButtons key={current.run.waiting.id} approvalId={current.run.waiting.id} heldBy={current.run.waiting.heldBy} onAnswered={onAnswered} />
                </div>
              )}
              {current.run.state === "failed" && current.run.error && <ErrorNote message={current.run.error} />}
              <RunLog log={current.log} compact />
            </>
          )}
        </section>
      )}

      <section className="recent-runs">
        <h3 className="section-title">Recent runs</h3>
        {recent.error && <ErrorNote message={recent.error} onRetry={() => void recent.reload()} />}
        {recent.data && recent.data.length === 0 && <p className="hint">This flow hasn't run yet.</p>}
        {recent.data && recent.data.length > 0 && (
          <ul className="recent-list">
            {recent.data.map((summary) => (
              <li key={summary.id}>
                <button type="button" className={summary.id === watching ? "recent-run active" : "recent-run"} aria-pressed={summary.id === watching} onClick={() => onWatch(summary.id)}>
                  <StateBadge state={summary.state} />
                  <time dateTime={summary.createdAt} title={fullTime(summary.createdAt)}>
                    {ago(summary.createdAt)}
                  </time>
                </button>
              </li>
            ))}
          </ul>
        )}
        {recent.data && recent.data.length > 0 && (
          <Link to={href.runs(flowId)} className="hint-link">
            All runs of this flow
          </Link>
        )}
      </section>
    </div>
  );
}
