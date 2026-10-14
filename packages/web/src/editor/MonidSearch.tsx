import { useState } from "react";
import { api, describeError } from "../api.ts";
import { Hint } from "../components/bits.tsx";
import type { FoundTool, ToolDetails } from "../types.ts";

type Search = { readonly status: "idle" } | { readonly status: "searching" } | { readonly status: "found"; readonly tools: readonly FoundTool[] } | { readonly status: "failed"; readonly error: string };

/**
 * Finding a Monid tool for the assistant being set up: describe what it should do, pick one from the
 * catalog (its price shown; tools Huddle won't run can't be picked), and its id and an input template
 * to start from go into the form.
 */
export function MonidSearch({ onPick }: { readonly onPick: (details: ToolDetails) => void }) {
  const [need, setNeed] = useState("");
  const [search, setSearch] = useState<Search>({ status: "idle" });
  const [picked, setPicked] = useState<ToolDetails | null>(null);
  const [picking, setPicking] = useState<string | null>(null);

  const find = async () => {
    if (need.trim().length < 2) return;
    setSearch({ status: "searching" });
    setPicked(null);
    try {
      setSearch({ status: "found", tools: await api.monidFind(need.trim()) });
    } catch (error) {
      setSearch({ status: "failed", error: describeError(error) });
    }
  };

  const pick = async (tool: FoundTool) => {
    setPicking(tool.tool);
    try {
      const details = await api.monidShow(tool.tool);
      setPicked(details);
      onPick(details);
    } catch (error) {
      setSearch({ status: "failed", error: describeError(error) });
    } finally {
      setPicking(null);
    }
  };

  return (
    <div className="field monid-search" data-monid-search="">
      <label htmlFor="monid-need">Find a tool</label>
      <div className="monid-search-row">
        <input
          id="monid-need"
          value={need}
          placeholder="What should it do? e.g. Google job listings in India"
          autoComplete="off"
          onChange={(event) => setNeed(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void find();
            }
          }}
        />
        <button type="button" className="btn btn-sm" disabled={need.trim().length < 2 || search.status === "searching"} onClick={() => void find()}>
          {search.status === "searching" ? "Searching…" : "Search"}
        </button>
      </div>
      {search.status === "failed" && <p className="error-text">{search.error}</p>}
      {search.status === "found" && search.tools.length === 0 && <Hint>Nothing in Monid's catalog fits that; try other words.</Hint>}
      {search.status === "found" && search.tools.length > 0 && (
        <ul className="monid-results">
          {search.tools.map((tool) => (
            <li key={tool.tool} className={tool.blocked ? "blocked" : picked?.tool === tool.tool ? "picked" : undefined} data-monid-tool={tool.tool}>
              <div className="monid-result-head">
                <span className="mono">{tool.tool}</span>
                <span className="monid-price">{tool.price}</span>
              </div>
              <p>{tool.description}</p>
              {tool.blocked ? (
                <p className="monid-blocked">Huddle won't run it: {tool.blocked}.</p>
              ) : (
                <button type="button" className="btn btn-sm" disabled={picking !== null} onClick={() => void pick(tool)}>
                  {picking === tool.tool ? "Reading it…" : picked?.tool === tool.tool ? "Picked" : "Use this tool"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {picked && (
        <div className="monid-fields">
          <p className="hint">It takes:</p>
          <ul>
            {picked.fields.map((field) => (
              <li key={`${field.group}.${field.name}`}>
                <span className="mono">
                  {field.group}.{field.name}
                </span>
                {field.required ? " (required)" : ""} {field.description}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
