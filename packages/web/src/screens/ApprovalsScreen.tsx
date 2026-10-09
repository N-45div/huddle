import { useState } from "react";
import { api, describeError } from "../api.ts";
import { useApp } from "../app-context.ts";
import { AnswerButtons } from "../components/Answer.tsx";
import { Empty, ErrorNote, Link, Loading } from "../components/bits.tsx";
import { useChanges } from "../events.ts";
import { ago, fullTime } from "../format.ts";
import { useDebounced, useResource } from "../hooks.ts";
import { href } from "../router.ts";
import type { SandboxRequestView, SignIn } from "../types.ts";

/** The inbox a person checks: everything a flow has stopped to ask, what OpenShell sandboxes need, and PACT sign-ins. */
export function ApprovalsScreen() {
  const { authVersion, info } = useApp();
  const approvals = useResource(() => api.approvals(), [authVersion]);
  const sandboxes = useResource(() => api.sandboxRequests(), [authVersion]);
  const signIns = useResource(() => api.signIns(), [authVersion]);
  const refetch = useDebounced(() => void approvals.reload(), 200);
  const refetchSandboxes = useDebounced(() => void sandboxes.reload(), 200);
  const refetchSignIns = useDebounced(() => void signIns.reload(), 200);

  useChanges((change) => {
    if (change.kind === "approval" || change.kind === "run" || change.kind === "resync") refetch();
    if (change.kind === "sandbox" || change.kind === "resync") refetchSandboxes();
    if (change.kind === "signin" || change.kind === "resync") refetchSignIns();
  });

  const list = approvals.data ? [...approvals.data].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : [];
  const requests = sandboxes.data?.requests ?? [];
  const waitingSignIns = signIns.data ?? [];
  const showSandboxes = Boolean(info?.openshell || sandboxes.data?.configured);

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

      {waitingSignIns.length > 0 && (
        <section aria-labelledby="signins-title">
          <h2 id="signins-title">Sign in to let Huddle act for you</h2>
          <p className="hint">You sign in on the business's own page; Huddle never sees your password. Once you approve there, the step carries on by itself.</p>
          <ul className="approval-list">
            {waitingSignIns.map((signIn) => (
              <SignInCard key={signIn.id} signIn={signIn} onDone={refetchSignIns} />
            ))}
          </ul>
        </section>
      )}

      {approvals.data && list.length === 0 && requests.length === 0 && waitingSignIns.length === 0 && (
        <Empty title="Nothing is waiting on you.">
          <p className="hint">When a flow reaches an approval step, or a sandboxed assistant needs to reach something new, it shows up here.</p>
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

      {showSandboxes && (
        <section className="sandbox-requests" aria-labelledby="sandbox-requests-title">
          <h2 id="sandbox-requests-title">Sandbox requests</h2>
          <p className="hint">
            OpenShell blocked these connections from a sandboxed assistant and drafted a rule for each. Allow one and the sandbox picks it up within a few seconds, so the
            assistant can try again.
          </p>
          {sandboxes.error && <ErrorNote message={sandboxes.error} onRetry={() => void sandboxes.reload()} />}
          {sandboxes.data && !sandboxes.data.connected && sandboxes.data.error && <ErrorNote message={`Can't reach OpenShell: ${sandboxes.data.error}`} />}
          {sandboxes.data?.connected && requests.length === 0 && <p className="hint">No sandbox is waiting on you.</p>}
          <ul className="approval-list">
            {requests.map((request) => (
              <SandboxRequestCard
                key={`${request.sandbox}/${request.id}`}
                request={request}
                onDecided={() => {
                  sandboxes.setData((current) => (current ? { ...current, requests: current.requests.filter((other) => other.id !== request.id || other.sandbox !== request.sandbox) } : current));
                  refetchSandboxes();
                }}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** The program's name, from the path OpenShell reports (/usr/bin/python3 -> python3). */
const programOf = (binary: string) => binary.split("/").filter(Boolean).at(-1) || binary || "A program";

/** What OpenShell's policy prover findings mean, in words a person deciding can use. */
const FINDINGS: Readonly<Record<string, string>> = {
  credential_reach_expansion: "this would let the program use a key that OpenShell holds for the sandbox, which it can't use now",
};

/** The prover's findings, when it reports any ("1 new finding credential_reach_expansion: ..."). */
function findingsIn(validation: string): string[] {
  if (!/\b[1-9]\d* new findings?\b/i.test(validation)) return [];
  const codes = [...new Set(validation.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [])];
  return codes.length ? codes.map((code) => FINDINGS[code] ?? code.replaceAll("_", " ")) : ["see OpenShell's check below"];
}

function SandboxRequestCard({ request, onDecided }: { readonly request: SandboxRequestView; readonly onDecided: () => void }) {
  const { refreshWaiting } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const findings = findingsIn(request.validation);
  const flagged = request.securityNotes.trim() !== "" || findings.length > 0;

  const decide = async (yes: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.answerSandboxRequest(request.sandbox, request.id, yes);
      refreshWaiting();
      onDecided();
    } catch (caught) {
      setError(describeError(caught));
      setBusy(false);
    }
  };

  return (
    <li className={`card approval-card${flagged ? " approval-card-flagged" : ""}`}>
      <p className="eyebrow">
        Sandbox <span className="step-chip">{request.sandbox}</span>
        {request.firstSeen && (
          <>
            {" · "}
            <time dateTime={request.firstSeen} title={fullTime(request.firstSeen)}>
              {ago(request.firstSeen)}
            </time>
          </>
        )}
        {request.hits > 1 && ` · tried ${request.hits} times`}
      </p>
      <p className="waiting-message">
        <code>{programOf(request.binary)}</code> wants to reach <strong>{request.endpoints.join(", ") || "a new destination"}</strong>
      </p>
      {request.rationale && <p className="hint">{request.rationale}</p>}
      <p className="hint">
        OpenShell's check: {request.validation || "not run yet"}
        {request.binary && (
          <>
            {" · program "}
            <code>{request.binary}</code>
          </>
        )}
      </p>
      {flagged && (
        <div className="note note-warn" role="note">
          <p>
            <strong>Look before allowing.</strong> OpenShell found a risk: {[...findings, request.securityNotes.trim()].filter(Boolean).join("; ")}.
          </p>
        </div>
      )}
      <div className="approval-foot">
        <div className="answer">
          <div className="answer-buttons">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void decide(true)}>
              Allow
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void decide(false)}>
              Deny
            </button>
          </div>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

/** A PACT sign-in: the business's login link, what Huddle asked to do (in the business's own words), and the code. */
function SignInCard({ signIn, onDone }: { readonly signIn: SignIn; readonly onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const act = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      onDone();
    } catch (caught) {
      setError(describeError(caught));
    }
  };
  return (
    <li className="card approval-card signin-card">
      <p className="eyebrow">
        {signIn.business} · <span className="step-chip">{signIn.assistant}</span> · expires{" "}
        <time dateTime={signIn.expiresAt} title={fullTime(signIn.expiresAt)}>
          {ago(signIn.expiresAt)}
        </time>
      </p>
      <p className="waiting-message">{signIn.business} wants you to sign in before Huddle can:</p>
      <ul className="signin-scopes">
        {signIn.scopes.map((scope) => (
          <li key={scope.id}>
            {scope.description} <span className="muted">({scope.id})</span>
          </li>
        ))}
      </ul>
      {signIn.userCode && (
        <p className="hint">
          If it asks for a code: <span className="signin-code">{signIn.userCode}</span>
        </p>
      )}
      <div className="signin-actions">
        <a className="btn btn-primary" href={signIn.link} target="_blank" rel="noopener noreferrer">
          Open {signIn.business}'s sign-in
        </a>
        <button
          type="button"
          className="btn"
          disabled={checking}
          onClick={() => {
            setChecking(true);
            void act(() => api.checkSignIn(signIn.id)).finally(() => setChecking(false));
          }}
        >
          {checking ? "Checking…" : "I've signed in"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => void act(() => api.cancelSignIn(signIn.id))}>
          Cancel
        </button>
        {signIn.runId && (
          <Link to={href.run(signIn.runId)} className="btn btn-sm btn-ghost">
            See the run
          </Link>
        )}
      </div>
      {error && <ErrorNote message={error} />}
    </li>
  );
}
