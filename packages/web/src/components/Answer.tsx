import { useState } from "react";
import { api, describeError } from "../api.ts";
import { useApp } from "../app-context.ts";

/** Yes / No for one waiting approval. */
export function AnswerButtons({ approvalId, onAnswered }: { readonly approvalId: string; readonly onAnswered?: (yes: boolean) => void }) {
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
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void answer(true)}>
          Yes
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void answer(false)}>
          No
        </button>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
