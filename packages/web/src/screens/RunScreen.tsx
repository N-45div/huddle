import { api } from "../api.ts";
import { useApp } from "../app-context.ts";
import { AgentsTree } from "../components/AgentsTree.tsx";
import { ErrorNote, Icon, Link, Loading, StateBadge } from "../components/bits.tsx";
import { ReceiptPanel } from "../components/ReceiptPanel.tsx";
import { RunLog } from "../components/RunLog.tsx";
import { useChanges } from "../events.ts";
import { fullTime } from "../format.ts";
import { useDebounced, useResource } from "../hooks.ts";
import { href } from "../router.ts";
import { STEP_STATE_LABEL, stepStates } from "../run-state.ts";

export function RunScreen({ runId }: { readonly runId: string }) {
  const { authVersion } = useApp();
  const detail = useResource(() => api.run(runId), [runId, authVersion]);
  const refetch = useDebounced(() => void detail.reload(), 150);

  useChanges((change) => {
    if (change.kind === "resync" || ((change.kind === "run" || change.kind === "approval") && change.runId === runId)) refetch();
  });

  const data = detail.data;
  const run = data?.run;
  const states = run ? stepStates(run) : {};
  const started = data?.log[0]?.at;
  const last = data?.log.at(-1)?.at;

  return (
    <div className="page">
      <Link to={href.runs()} className="back-link">
        <Icon name="back" /> Runs
      </Link>

      {detail.error && <ErrorNote message={detail.error} onRetry={() => void detail.reload()} />}
      {detail.loading && !data && <Loading label="Loading the run…" />}

      {data && run && (
        <>
          <header className="page-head">
            <div>
              <h1>
                {data.flow.name} <StateBadge state={run.state} />
              </h1>
              <p className="lede">
                Run <code>{run.id}</code>
                {started && <> · started {fullTime(started)}</>}
                {last && last !== started && <> · last step {fullTime(last)}</>}
              </p>
            </div>
            {run.flowId && (
              <div className="page-actions">
                <Link to={href.flow(run.flowId)} className="btn">
                  Open the flow
                </Link>
              </div>
            )}
          </header>

          {/* Who's working on it, live; a card that needs you takes your answer, a failed run can be retried. */}
          <section className="section">
            <AgentsTree detail={data} onChange={refetch} />
          </section>

          {run.state === "failed" && <ErrorNote message={`${run.at ? `Step "${run.at}" failed: ` : ""}${run.error ?? "The run failed."}`} />}

          <section className="section">
            <h2>Steps</h2>
            <ol className="step-strip">
              {data.flow.steps.map((step) => {
                const state = states[step.id];
                return (
                  <li key={step.id} className={state ? `strip-step run-${state}` : "strip-step"}>
                    <span className="strip-id">{step.id}</span>
                    <span className="strip-state">{state ? STEP_STATE_LABEL[state] : "Not reached"}</span>
                  </li>
                );
              })}
            </ol>
          </section>

          <section className="section">
            <h2>Input</h2>
            {run.context.input ? <pre className="block">{run.context.input}</pre> : <p className="hint">This run had no input.</p>}
          </section>

          {data.receipt && (
            <section className="section">
              <h2>Where your data went</h2>
              <ReceiptPanel receipt={data.receipt} />
            </section>
          )}

          <section className="section">
            <h2>What happened</h2>
            <RunLog log={data.log} />
          </section>
        </>
      )}
    </div>
  );
}
