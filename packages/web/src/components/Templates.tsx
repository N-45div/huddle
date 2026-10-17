import { useState } from "react";
import { api, describeError } from "../api.ts";
import { useApp } from "../app-context.ts";
import { useResource } from "../hooks.ts";
import { Huddler } from "../huddlers/Huddler.tsx";
import { href } from "../router.ts";
import type { FlowView, Template } from "../types.ts";
import { ErrorNote, Link } from "./bits.tsx";

/** The example flows to start from: one click makes it yours and opens it on its Run tab, its example ready. */
export function Templates({ flows }: { readonly flows: readonly FlowView[] }) {
  const { authVersion, navigate } = useApp();
  const templates = useResource(() => api.templates(), [authVersion]);
  const [using, setUsing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const use = async (template: Template) => {
    setUsing(template.id);
    setError(null);
    try {
      const view = await api.createFlow(template.flow);
      navigate(href.tryFlow(view.id));
    } catch (caught) {
      setError(describeError(caught));
      setUsing(null);
    }
  };

  if (!templates.data || templates.data.length === 0) return null;
  const yours = new Map(flows.map((flow) => [flow.flow.name, flow.id]));
  return (
    <section className="templates" aria-labelledby="templates-title">
      <div className="templates-head">
        <h2 id="templates-title">Start from a template</h2>
        <p className="hint">Each one runs end to end. Use one and it opens ready to run, with an example to try.</p>
      </div>
      {error && <ErrorNote message={`Couldn't add it. ${error}`} />}
      <ul className="template-grid">
        {templates.data.map((template) => {
          const connectors = [...new Set(template.flow.assistants.map((assistant) => assistant.connector))].slice(0, 4);
          const added = yours.get(template.flow.name);
          return (
            <li key={template.id} className="card template-card">
              <div className="template-crew" aria-hidden="true">
                {connectors.map((connector) => (
                  <Huddler key={connector} id={`template-${template.id}-${connector}`} connector={connector} size={30} />
                ))}
              </div>
              <h3 className="template-name">{template.flow.name}</h3>
              {template.flow.description && <p className="template-description">{template.flow.description}</p>}
              <p className="template-uses">
                {template.uses.map((name) => (
                  <span key={name} className="chip chip-static">
                    {name}
                  </span>
                ))}
              </p>
              {template.missing.length > 0 && <p className="template-missing">Needs {template.missing.join(", ")} where Huddle runs.</p>}
              <div className="template-actions">
                {added && (
                  <Link to={href.flow(added)} className="btn btn-sm btn-ghost">
                    Open yours
                  </Link>
                )}
                <button type="button" className={`btn btn-sm ${template.missing.length === 0 && !added ? "btn-primary" : ""}`} disabled={using !== null} onClick={() => void use(template)}>
                  {using === template.id ? "Adding…" : added ? "Add another" : "Use this"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
