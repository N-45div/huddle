import { api } from "../api.ts";
import { useApp } from "../app-context.ts";
import { Empty, ErrorNote, Link, Loading, StateBadge } from "../components/bits.tsx";
import { useChanges } from "../events.ts";
import { ago, fullTime } from "../format.ts";
import { useDebounced, useResource } from "../hooks.ts";
import { href } from "../router.ts";

export function RunsScreen({ flowFilter }: { readonly flowFilter: string | null }) {
  const { authVersion, navigate } = useApp();
  const flows = useResource(() => api.flows(), [authVersion]);
  const runs = useResource(() => api.runs({ flow: flowFilter ?? undefined, limit: 100 }), [flowFilter, authVersion]);
  const refetch = useDebounced(() => void runs.reload(), 250);
  const refetchFlows = useDebounced(() => void flows.reload(), 250);

  useChanges((change) => {
    if (change.kind === "run" || change.kind === "approval" || change.kind === "resync") refetch();
    if (change.kind === "flow" || change.kind === "resync") refetchFlows();
  });

  const flowOptions = flows.data ? [...flows.data].sort((a, b) => a.flow.name.localeCompare(b.flow.name)) : [];
  const filterKnown = !flowFilter || flowOptions.some((view) => view.id === flowFilter);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Runs</h1>
          <p className="lede">Every time a flow runs, what each step was asked and answered.</p>
        </div>
        <div className="page-actions">
          <label className="inline-label" htmlFor="runs-filter">
            Flow
          </label>
          <select id="runs-filter" value={flowFilter ?? ""} onChange={(event) => navigate(href.runs(event.target.value || null))}>
            <option value="">All flows</option>
            {!filterKnown && flowFilter && <option value={flowFilter}>This flow</option>}
            {flowOptions.map((view) => (
              <option key={view.id} value={view.id}>
                {view.flow.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      {runs.error && <ErrorNote message={runs.error} onRetry={() => void runs.reload()} />}
      {runs.loading && !runs.data && <Loading label="Loading runs…" />}

      {runs.data && runs.data.length === 0 && (
        <Empty title={flowFilter ? "This flow hasn't run yet." : "No runs yet."}>
          <p className="hint">Open a flow and press Run, or give it a schedule or a webhook.</p>
        </Empty>
      )}

      {runs.data && runs.data.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Flow</th>
                <th scope="col">State</th>
                <th scope="col" className="col-optional">
                  Step
                </th>
                <th scope="col">Started</th>
                <th scope="col" className="col-optional">
                  Last change
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.data.map((run) => (
                <tr key={run.id}>
                  <td>
                    <Link to={href.run(run.id)} className="row-title">
                      {run.flowName}
                    </Link>
                    {run.error && <p className="row-sub danger-text">{run.error}</p>}
                  </td>
                  <td>
                    <StateBadge state={run.state} />
                  </td>
                  <td className="col-optional">{run.at ? <span className="step-chip">{run.at}</span> : <span className="muted">–</span>}</td>
                  <td>
                    <time dateTime={run.createdAt} title={fullTime(run.createdAt)}>
                      {ago(run.createdAt)}
                    </time>
                  </td>
                  <td className="col-optional">
                    <time dateTime={run.updatedAt} title={fullTime(run.updatedAt)}>
                      {ago(run.updatedAt)}
                    </time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
