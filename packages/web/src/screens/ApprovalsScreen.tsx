import { api } from "../api.ts";
import { useApp } from "../app-context.ts";
import { AnswerButtons } from "../components/Answer.tsx";
import { Empty, ErrorNote, Link, Loading } from "../components/bits.tsx";
import { useChanges } from "../events.ts";
import { ago, fullTime } from "../format.ts";
import { useDebounced, useResource } from "../hooks.ts";
import { href } from "../router.ts";

/** The inbox a person checks: everything a flow has stopped to ask. */
export function ApprovalsScreen() {
  const { authVersion } = useApp();
  const approvals = useResource(() => api.approvals(), [authVersion]);
  const refetch = useDebounced(() => void approvals.reload(), 200);

  useChanges((change) => {
    if (change.kind === "approval" || change.kind === "run" || change.kind === "resync") refetch();
  });

  const list = approvals.data ? [...approvals.data].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : [];

  return (
    <div className="page page-narrow">
      <header className="page-head">
        <div>
          <h1>Approvals</h1>
          <p className="lede">A flow stops here and waits until you say yes or no.</p>
        </div>
      </header>

      {approvals.error && <ErrorNote message={approvals.error} onRetry={() => void approvals.reload()} />}
      {approvals.loading && !approvals.data && <Loading label="Loading approvals…" />}

      {approvals.data && list.length === 0 && (
        <Empty title="Nothing is waiting on you.">
          <p className="hint">When a flow reaches an approval step, it shows up here.</p>
        </Empty>
      )}

      <ul className="approval-list">
        {list.map((approval) => (
          <li key={approval.id} className="card approval-card">
            <p className="eyebrow">
              {approval.flowName} · <span className="step-chip">{approval.stepId}</span> ·{" "}
              <time dateTime={approval.createdAt} title={fullTime(approval.createdAt)}>
                {ago(approval.createdAt)}
              </time>
            </p>
            <p className="waiting-message">{approval.message}</p>
            <div className="approval-foot">
              <AnswerButtons
                approvalId={approval.id}
                onAnswered={() => {
                  approvals.setData((current) => current?.filter((other) => other.id !== approval.id) ?? null);
                  refetch();
                }}
              />
              <Link to={href.run(approval.runId)} className="btn btn-sm btn-ghost">
                See the run
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
