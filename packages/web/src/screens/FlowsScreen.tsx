import { useState } from "react";
import { api, describeError } from "../api.ts";
import { useApp } from "../app-context.ts";
import { Empty, ErrorNote, Link, Loading } from "../components/bits.tsx";
import { ConfirmDialog } from "../components/Dialog.tsx";
import { Templates } from "../components/Templates.tsx";
import { useChanges } from "../events.ts";
import { ago, fullTime, plural, triggerSummary } from "../format.ts";
import { useDebounced, useResource } from "../hooks.ts";
import { href } from "../router.ts";
import type { Flow, FlowView } from "../types.ts";
import { Huddler } from "../huddlers/Huddler.tsx";

/** What "New flow" starts from: one approval step, so the flow is valid from the first save. */
const NEW_FLOW: Flow = {
  name: "Untitled flow",
  trigger: { type: "manual" },
  assistants: [],
  steps: [{ id: "start", type: "approval", message: "Ready?" }],
};

export function FlowsScreen() {
  const { info, authVersion, navigate } = useApp();
  const flows = useResource(() => api.flows(), [authVersion]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<FlowView | null>(null);
  const refetch = useDebounced(() => void flows.reload());

  useChanges((change) => {
    if (change.kind === "flow" || change.kind === "resync") refetch();
  });

  const create = async (describe: boolean) => {
    setCreating(true);
    setCreateError(null);
    try {
      const view = await api.createFlow(NEW_FLOW);
      navigate(href.flow(view.id, describe));
    } catch (caught) {
      setCreateError(describeError(caught));
      setCreating(false);
    }
  };

  const list = flows.data ? [...flows.data].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : [];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Flows</h1>
          <p className="lede">Each flow hands work between your assistants, and stops for you where it matters.</p>
        </div>
        <div className="page-actions">
          {info?.describe && (
            <button type="button" className="btn" disabled={creating} onClick={() => void create(true)}>
              Describe it
            </button>
          )}
          <button type="button" className="btn btn-primary" disabled={creating} onClick={() => void create(false)}>
            {creating ? "Making…" : "New flow"}
          </button>
        </div>
      </header>

      {createError && <ErrorNote message={`Couldn't make a new flow. ${createError}`} />}
      {flows.error && <ErrorNote message={flows.error} onRetry={() => void flows.reload()} />}
      {flows.loading && !flows.data && <Loading label="Loading flows…" />}

      {flows.data && list.length === 0 && (
        <Empty
          title={info?.describe ? "No flows yet. Make one, or describe it." : "No flows yet. Make one to get started."}
          art={
            <div className="huddlers-row">
              <Huddler id="sleepy-llama" connector="ollama" mood="sleepy" size={64} live />
              <Huddler mood="waiting" size={84} live />
              <Huddler id="nap-2" connector="hermes" mood="sleepy" size={64} live />
            </div>
          }
        >
          <div className="empty-actions">
            <button type="button" className="btn btn-primary" disabled={creating} onClick={() => void create(false)}>
              New flow
            </button>
            {info?.describe && (
              <button type="button" className="btn" disabled={creating} onClick={() => void create(true)}>
                Describe it
              </button>
            )}
          </div>
        </Empty>
      )}

      {list.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col" className="col-optional">
                  Starts
                </th>
                <th scope="col">Steps</th>
                <th scope="col" className="col-optional">
                  Updated
                </th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((view) => (
                <tr key={view.id}>
                  <td>
                    <Link to={href.flow(view.id)} className="row-title">
                      {view.flow.name}
                    </Link>
                    {view.flow.description && <p className="row-sub">{view.flow.description}</p>}
                  </td>
                  <td className="col-optional">{triggerSummary(view.flow.trigger)}</td>
                  <td>{plural(view.flow.steps.length, "step")}</td>
                  <td className="col-optional">
                    <time dateTime={view.updatedAt} title={fullTime(view.updatedAt)}>
                      {ago(view.updatedAt)}
                    </time>
                  </td>
                  <td className="cell-actions">
                    <Link to={href.runs(view.id)} className="btn btn-sm btn-ghost">
                      Runs
                    </Link>
                    <button type="button" className="btn btn-sm btn-ghost danger-text" onClick={() => setDeleting(view)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {flows.data && <Templates flows={list} />}

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete "${deleting?.flow.name ?? ""}"?`}
        confirmLabel="Delete flow"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          await api.deleteFlow(deleting.id);
          flows.setData((current) => current?.filter((view) => view.id !== deleting.id) ?? null);
          setDeleting(null);
        }}
      >
        <p>The flow goes away, along with its schedule and webhook address. This can't be undone.</p>
      </ConfirmDialog>
    </div>
  );
}
