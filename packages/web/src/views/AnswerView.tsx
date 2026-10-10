import { useEffect, useId, useRef, useState } from "react";
import { api, describeError } from "../api.ts";
import { useApp } from "../app-context.ts";
import type { PresentedView, View } from "../types.ts";
import { Calculator } from "./Calculator.tsx";
import { Chart, type ChartSpec } from "./Chart.tsx";
import { Comparison } from "./Comparison.tsx";
import { Flowchart } from "./Flowchart.tsx";

/**
 * An answer you can interact with: Huddle chooses how best to show it (Jev or your model, else the rules)
 * and draws it, from checked JSON and never from code a model wrote. "Ask about this" puts a follow-up
 * where you'd type it; nothing is sent until you send it.
 */

type Kind = View["kind"];

export const KIND_NAMES: Readonly<Record<Kind, string>> = {
  text: "Text",
  table: "Table",
  bar_chart: "Bar chart",
  line_chart: "Line chart",
  part_to_whole: "Shares of a whole",
  flowchart: "Flowchart",
  calculator: "Calculator",
  comparison: "Comparison",
};

const FILLED: readonly Kind[] = ["bar_chart", "line_chart", "part_to_whole", "flowchart", "calculator", "comparison"];
const CHOOSERS: Readonly<Record<string, string>> = { jev: "Jev", model: "your model", rules: "the answer's shape", you: "you" };

type State = { readonly status: "idle" } | { readonly status: "busy"; readonly kind: Kind | null } | { readonly status: "done"; readonly presented: PresentedView } | { readonly status: "failed"; readonly message: string };

export function AnswerView({
  text,
  data,
  ask,
  assistant,
  auto = false,
  onAsk,
}: {
  readonly text: string;
  readonly data?: unknown;
  readonly ask?: string;
  readonly assistant?: string;
  /** Choose and show at once (else on "Show it"). */
  readonly auto?: boolean;
  readonly onAsk?: (text: string) => void;
}) {
  const { info } = useApp();
  const [state, setState] = useState<State>({ status: "idle" });
  const asked = useRef(0);
  const pickId = useId();
  const canFill = Boolean(info?.present.writer);
  const kinds: Kind[] = ["table", ...(canFill ? FILLED : [])];

  const show = async (kind?: Kind) => {
    const call = ++asked.current;
    setState({ status: "busy", kind: kind ?? null });
    try {
      const presented = await api.present({ text, ...(data !== undefined && data !== null ? { data } : {}), ...(ask ? { ask } : {}), ...(assistant ? { assistant } : {}), ...(kind ? { kind } : {}) });
      if (call === asked.current) setState({ status: "done", presented });
    } catch (error) {
      if (call === asked.current) setState({ status: "failed", message: describeError(error) });
    }
  };

  useEffect(() => {
    if (auto) void show();
    // A new answer is chosen for afresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, text]);

  const picker = (
    <span className="view-pick">
      <label htmlFor={pickId}>Show it as</label>
      <select
        id={pickId}
        value=""
        onChange={(event) => {
          if (event.target.value) void show(event.target.value as Kind);
        }}
      >
        <option value="">…</option>
        {kinds.map((kind) => (
          <option key={kind} value={kind}>
            {KIND_NAMES[kind]}
          </option>
        ))}
      </select>
    </span>
  );

  if (state.status === "idle") {
    return (
      <div className="view-bar">
        <button type="button" className="btn btn-sm" onClick={() => void show()}>
          Show it
        </button>
        {picker}
      </div>
    );
  }
  if (state.status === "busy") {
    return (
      <p className="hint view-busy" role="status">
        <span className="spinner" aria-hidden="true" />
        {state.kind && FILLED.includes(state.kind) ? `Filling in a ${KIND_NAMES[state.kind].toLowerCase()}…` : "Choosing how to show it…"}
      </p>
    );
  }
  if (state.status === "failed") {
    return (
      <div className="view-bar">
        <p className="error-text" role="alert">
          {state.message}
        </p>
        {picker}
      </div>
    );
  }
  const { view, choice } = state.presented;
  const chosen = `Chosen by ${CHOOSERS[choice.by] ?? choice.by}${choice.confidence !== null ? `, ${Math.round(choice.confidence * 100)}% sure` : ""}`;
  if (view.kind === "text") {
    return (
      <div className="view-bar">
        <p className="hint">Best as it is. {chosen}.</p>
        {picker}
      </div>
    );
  }
  return (
    <figure className={`answer-view view-${view.kind}`}>
      <figcaption>
        <strong>{view.title}</strong>
        <span className="hint">
          {KIND_NAMES[view.kind]} · {chosen}
        </span>
      </figcaption>
      <ViewBody view={view} onAsk={onAsk} />
      <footer className="view-foot">
        <p className="hint">
          From {view.source}
          {"assumptions" in view && view.assumptions.length > 0 ? `. Assumed: ${view.assumptions.join("; ")}` : ""}.
        </p>
        {picker}
      </footer>
    </figure>
  );
}

function ViewBody({ view, onAsk }: { readonly view: Exclude<View, { kind: "text" }>; readonly onAsk?: (text: string) => void }) {
  switch (view.kind) {
    case "table":
      return (
        <div className="view-table-wrap" tabIndex={0}>
          <table className="view-table">
            <thead>
              <tr>
                {view.table.columns.map((column) => (
                  <th key={column} scope="col">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.table.rows.map((row, index) => (
                <tr key={index}>
                  {row.map((value, column) => (
                    <td key={column}>{value}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {view.table.truncated && <p className="hint">Only the first 200 rows and 12 columns are shown.</p>}
        </div>
      );
    case "flowchart":
      return <Flowchart view={view} />;
    case "calculator":
      return <Calculator view={view} onAsk={onAsk} />;
    case "comparison":
      return <Comparison view={view} onAsk={onAsk} />;
    default:
      return <Chart view={view as ChartSpec} />;
  }
}
