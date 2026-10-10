import { useId, useState } from "react";
// Pure arithmetic shared with the server, which checked these formulas before they got here.
import { evaluateFormula, FormulaError } from "../../../core/src/formula.ts";
import type { View } from "../types.ts";
import { withUnit } from "./Chart.tsx";

/** A calculator from a checked view: change the inputs and the results follow, worked out by Huddle's own arithmetic. */

export type CalculatorSpec = Extract<View, { kind: "calculator" }>;

type Input = CalculatorSpec["inputs"][number];

/** An input's number, or what's wrong with it. */
function read(input: Input, raw: string): number | string {
  if (!raw.trim()) return "Needs a number.";
  const value = Number(raw.trim().replace(/,/g, ""));
  if (!Number.isFinite(value)) return "That isn't a number.";
  if (input.min !== undefined && value < input.min) return `At least ${withUnit(input.min, input.unit)}.`;
  if (input.max !== undefined && value > input.max) return `At most ${withUnit(input.max, input.unit)}.`;
  return value;
}

export function Calculator({ view, onAsk }: { readonly view: CalculatorSpec; readonly onAsk?: (text: string) => void }) {
  const initial = () => Object.fromEntries(view.inputs.map((input) => [input.id, String(input.value)]));
  const [raw, setRaw] = useState<Record<string, string>>(initial);
  const prefix = useId();
  const entries = view.inputs.map((input) => ({ input, value: read(input, raw[input.id] ?? "") }));
  const values = Object.fromEntries(entries.flatMap(({ input, value }) => (typeof value === "number" ? [[input.id, value]] : [])));
  const ready = entries.every(({ value }) => typeof value === "number");
  const results = view.outputs.map((output) => {
    if (!ready) return { output, text: "—", error: null as string | null };
    try {
      return { output, text: withUnit(evaluateFormula(output.formula, values), output.unit, output.decimals, true), error: null };
    } catch (error) {
      return { output, text: "—", error: error instanceof FormulaError ? error.message : String(error) };
    }
  });

  const ask = () => {
    const given = view.inputs.map((input) => `${input.label} ${withUnit(values[input.id] ?? 0, input.unit)}`).join(", ");
    const got = results.map((result) => `${result.output.label} ${result.text}`).join(", ");
    onAsk?.(`With ${given}, ${got}. `);
  };

  return (
    <div className="calculator">
      <div className="calc-inputs">
        {entries.map(({ input, value }) => {
          const id = `${prefix}-${input.id}`;
          const problem = typeof value === "string" ? value : null;
          return (
            <div key={input.id} className="field calc-field">
              <label htmlFor={id}>{input.label}</label>
              <div className="input-suffix">
                <input
                  id={id}
                  inputMode="decimal"
                  value={raw[input.id] ?? ""}
                  aria-invalid={problem ? true : undefined}
                  aria-describedby={problem ? `${id}-problem` : undefined}
                  onChange={(event) => setRaw((current) => ({ ...current, [input.id]: event.target.value }))}
                />
                {input.unit && <span>{input.unit}</span>}
              </div>
              {problem && (
                <p className="error-text" id={`${id}-problem`}>
                  {problem}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <dl className="calc-outputs" aria-live="polite">
        {results.map((result) => (
          <div key={result.output.label} className="calc-output">
            <dt>{result.output.label}</dt>
            <dd>
              <strong>{result.text}</strong>
              {result.error && <span className="error-text"> {result.error}</span>}
              <code className="calc-formula" title="How it's worked out">
                {result.output.formula}
              </code>
            </dd>
          </div>
        ))}
      </dl>
      <div className="view-actions">
        <button type="button" className="btn btn-sm" onClick={() => setRaw(initial())}>
          Reset
        </button>
        {onAsk && ready && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={ask}>
            Ask about this
          </button>
        )}
      </div>
    </div>
  );
}
