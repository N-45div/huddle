import { useId, useState } from "react";
import type { View } from "../types.ts";

/** Options weighed against criteria from a checked view: move the weights and the totals and the best fit follow. */

export type ComparisonSpec = Extract<View, { kind: "comparison" }>;

export function Comparison({ view, onAsk }: { readonly view: ComparisonSpec; readonly onAsk?: (text: string) => void }) {
  const initial = () => view.criteria.map((criterion) => criterion.weight);
  const [weights, setWeights] = useState<number[]>(initial);
  const prefix = useId();
  const sum = weights.reduce((total, weight) => total + weight, 0);
  const totals = view.options.map((_, row) => (sum > 0 ? view.criteria.reduce((total, _criterion, column) => total + (view.scores[row]?.[column] ?? 0) * (weights[column] ?? 0), 0) / sum : null));
  const best = sum > 0 ? Math.max(...totals.map((total) => total ?? 0)) : null;
  const one = (value: number) => value.toFixed(1);

  const ask = () => {
    const weighed = view.criteria.map((criterion, index) => `${criterion.name} ${weights[index]}`).join(", ");
    const scored = view.options.map((option, index) => `${option.name} ${one(totals[index] ?? 0)}`).join(", ");
    onAsk?.(`Weighing ${weighed} (out of 10): ${scored}. `);
  };

  return (
    <div className="comparison">
      <fieldset className="weights">
        <legend>How much each matters</legend>
        {view.criteria.map((criterion, index) => {
          const id = `${prefix}-${index}`;
          return (
            <div key={criterion.name} className="weight">
              <label htmlFor={id}>{criterion.name}</label>
              <input id={id} type="range" min={0} max={10} step={1} value={weights[index] ?? 0} onChange={(event) => setWeights((current) => current.map((weight, at) => (at === index ? Number(event.target.value) : weight)))} />
              <output htmlFor={id}>{weights[index]}</output>
            </div>
          );
        })}
      </fieldset>
      {sum === 0 && <p className="hint">Give at least one of them some weight.</p>}
      <div className="view-table-wrap" tabIndex={0}>
        <table className="view-table">
          <thead>
            <tr>
              <th scope="col">Option</th>
              {view.criteria.map((criterion) => (
                <th key={criterion.name} scope="col">
                  {criterion.name}
                </th>
              ))}
              <th scope="col">Weighted</th>
            </tr>
          </thead>
          <tbody>
            {view.options.map((option, row) => {
              const total = totals[row];
              const top = best !== null && typeof total === "number" && total === best;
              return (
                <tr key={option.name} className={top ? "best" : undefined}>
                  <th scope="row">
                    {option.name}
                    {top && <span className="badge">Best fit</span>}
                    {option.note && <span className="option-note">{option.note}</span>}
                  </th>
                  {view.criteria.map((criterion, column) => (
                    <td key={criterion.name}>{view.scores[row]?.[column] ?? "—"}</td>
                  ))}
                  <td>
                    <strong>{total === null || total === undefined ? "—" : one(total)}</strong>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="hint">Scores are out of 10, higher is better.</p>
      <div className="view-actions">
        <button type="button" className="btn btn-sm" onClick={() => setWeights(initial())}>
          Reset the weights
        </button>
        {onAsk && sum > 0 && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={ask}>
            Ask about this
          </button>
        )}
      </div>
    </div>
  );
}
