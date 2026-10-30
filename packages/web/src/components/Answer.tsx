import { useState } from "react";
import { api, describeError } from "../api.ts";
import { useApp } from "../app-context.ts";
import type { HeldBy } from "../types.ts";

/**
 * Yes / No for one waiting approval. A hand-off ArmorIQ holds is approved there instead: the yes is a link to
 * its page, and the run carries on by itself once you approve it. A payment (`signs`) has no yes here at all:
 * only your board's signature pays. A no here still stops either.
 */
export function AnswerButtons({
  approvalId,
  heldBy,
  signs,
  onAnswered,
}: {
  readonly approvalId: string;
  readonly heldBy?: HeldBy | null;
  /** The payment this approval waits on, when only your board's signature says yes. */
  readonly signs?: string | null;
  readonly onAnswered?: (yes: boolean) => void;
}) {
  const { refreshWaiting } = useApp();
  const [busy, setBusy] = useState(false);
  const [answered, setAnswered] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const answer = async (yes: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.answer(approvalId, yes);
      setAnswered(yes);
      refreshWaiting();
      onAnswered?.(yes);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  if (answered !== null) {
    return (
      <p className="answer-done" role="status">
        You said {answered ? "yes" : "no"}. The run carries on.
      </p>
    );
  }

  return (
    <div className="answer">
      <div className="answer-buttons">
        {signs ? null : heldBy ? (
          <a className="btn btn-primary" href={heldBy.url} target="_blank" rel="noopener noreferrer">
            Approve in {heldBy.by}
          </a>
        ) : (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void answer(true)}>
            Yes
          </button>
        )}
        <button type="button" className="btn" disabled={busy} onClick={() => void answer(false)}>
          {signs ? "Don't pay" : "No"}
        </button>
      </div>
      {signs && (
        <p className="hint held-hint">
          <strong>Sign it on your board:</strong> hold its button for a second, or use the virtual board in Devices. Only the board's signature pays; Huddle carries on by itself once it has it.
        </p>
      )}
      {heldBy && !signs && <p className="hint held-hint">Only {heldBy.by} can let this one through. Huddle carries on by itself once you approve it there.</p>}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
