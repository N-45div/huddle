import { useEffect, useRef, useState } from "react";
import { ApiFailure, api, describeError } from "../api.ts";
import { Hint } from "../components/bits.tsx";
import { fullTime } from "../format.ts";
import type { Flow, FlowView } from "../types.ts";

interface Props {
  readonly view: FlowView;
  readonly description: string;
  readonly onDescription: (description: string) => void;
  /** Whether the server can draw a flow from a sentence (/api/info.describe). */
  readonly canDescribe: boolean;
  readonly focusDescribe: boolean;
  readonly onDescribed: (flow: Flow) => void;
}

export function FlowPanel({ view, description, onDescription, canDescribe, focusDescribe, onDescribed }: Props) {
  return (
    <div className="inspector-section">
      {canDescribe && <DescribeBox autoFocus={focusDescribe} onDescribed={onDescribed} />}

      <div className="field">
        <label htmlFor="flow-description">Description</label>
        <textarea id="flow-description" rows={3} value={description} aria-describedby="flow-description-hint" onChange={(event) => onDescription(event.target.value)} />
        <Hint id="flow-description-hint">What this flow is for, in a line. Shown in the list of flows.</Hint>
      </div>

      <dl className="facts">
        <dt>Id</dt>
        <dd>
          <code>{view.id}</code>
        </dd>
        <dt>Made</dt>
        <dd>{fullTime(view.createdAt)}</dd>
        <dt>Last saved</dt>
        <dd>{fullTime(view.updatedAt)}</dd>
      </dl>
    </div>
  );
}

function DescribeBox({ autoFocus, onDescribed }: { readonly autoFocus: boolean; readonly onDescribed: (flow: Flow) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) area.current?.focus();
  }, [autoFocus]);

  const submit = async () => {
    if (!text.trim()) {
      setError("Write a sentence about what the flow should do first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { flow } = await api.describe(text.trim());
      onDescribed(flow);
    } catch (caught) {
      setError(caught instanceof ApiFailure && caught.status === 501 ? "Describe it isn't set up on this server: it needs an AI model configured." : describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="card describe-box"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor="describe-text" className="card-title">
        Describe the flow in a sentence
      </label>
      <textarea
        id="describe-text"
        ref={area}
        rows={4}
        value={text}
        aria-describedby="describe-hint"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <Hint id="describe-hint">Say who does what, and where you want a say. Huddle draws it on the canvas; nothing is saved until you press Save.</Hint>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="form-foot">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Drawing…" : "Draw it"}
        </button>
      </div>
    </form>
  );
}
