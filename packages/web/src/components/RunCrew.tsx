import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api, describeError } from "../api.ts";
import { dollars } from "../format.ts";
import { Huddler } from "../huddlers/Huddler.tsx";
import { type CrewNode, type CrewStatus, crewOf, elapsed, nodesOf, type ToolMark } from "../run-crew.ts";
import type { HeldBy, RunDetail } from "../types.ts";
import { AnswerButtons } from "./Answer.tsx";

/**
 * Who's on a run, live, as a relay: one row per hand-off down a rail of Huddlers, in the order they happened,
 * each with its model, what it was asked, its state, what it cost and how long it took. What a row fanned out
 * to (a fact check, earlier tries) sits indented under it. A row that's waiting for you takes your answer
 * there; a run that failed shows why on the row that failed, with Try again.
 */
export function RunCrew({ detail, onChange }: { readonly detail: RunDetail; readonly onChange: () => void }) {
  const run = useMemo(() => crewOf(detail), [detail]);
  const rows = [run, ...run.children];
  const everyone = nodesOf(run);
  const live = run.endedAt === null;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [live]);

  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setHidden((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const list = useRef<HTMLOListElement>(null);
  const waiting = everyone.filter((node) => node.status === "needs-you" && node.kind !== "run");
  // Each assistant once, however many times its step was tried.
  const assistants = new Set(everyone.filter((node) => node.kind !== "run" && node.kind !== "you").map((node) => node.avatar.id ?? node.key)).size;
  const toWaiting = () => list.current?.querySelector<HTMLElement>(".crew-row.crew-needs-you:not(.crew-run)")?.scrollIntoView({ behavior: "smooth", block: "center" });

  const row = (node: CrewNode, nested = false): ReactNode => (
    <CrewRow
      key={node.key}
      node={node}
      nested={nested}
      hidden={hidden.has(node.key)}
      onToggle={() => toggle(node.key)}
      heldBy={detail.run.waiting?.heldBy ?? null}
      canRetry={detail.run.state === "failed"}
      runId={detail.run.id}
      onChange={onChange}
      renderChild={(child) => row(child, true)}
    />
  );

  return (
    <section className="crew" aria-label="Who's on this run">
      <div className="crew-head">
        <h2>Who's on it</h2>
        <p className="crew-summary">
          {assistants === 1 ? "1 assistant" : `${assistants} assistants`}
          {run.costUsd !== null && <> · {dollars(run.costUsd)}</>} · {elapsed(run.startedAt, run.endedAt)}
          {waiting.length > 0 && (
            <button type="button" className="badge state-waiting crew-jump" onClick={toWaiting}>
              Waiting for you
            </button>
          )}
        </p>
      </div>
      <ol className="crew-list card" ref={list}>
        {rows.map((node) => row(node))}
      </ol>
    </section>
  );
}

interface RowProps {
  readonly node: CrewNode;
  readonly nested: boolean;
  readonly hidden: boolean;
  readonly onToggle: () => void;
  readonly heldBy: HeldBy | null;
  readonly canRetry: boolean;
  readonly runId: string;
  readonly onChange: () => void;
}

const LABEL: Record<CrewStatus, { readonly text: string; readonly badge: string }> = {
  running: { text: "Running", badge: "state-running" },
  done: { text: "Done", badge: "state-done" },
  "needs-you": { text: "Waiting for you", badge: "state-waiting" },
  failed: { text: "Failed", badge: "state-failed" },
  stopped: { text: "Stopped", badge: "" },
  declined: { text: "Declined", badge: "" },
};

const MOOD = { running: "thinking", done: "happy", "needs-you": "waiting", failed: "oops", stopped: "sleepy", declined: "sleepy" } as const;

function CrewRow({ node, nested, hidden, onToggle, heldBy, canRetry, runId, onChange, renderChild }: RowProps & { readonly renderChild: (child: CrewNode) => ReactNode }) {
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const isRun = node.kind === "run";
  const retry = async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      await api.retryRun(runId);
      onChange();
    } catch (error) {
      setRetryError(describeError(error));
    } finally {
      setRetrying(false);
    }
  };
  const label = LABEL[node.status];
  const time = elapsed(node.startedAt, node.endedAt);

  return (
    <li className={`crew-row crew-${node.status}${isRun ? " crew-run" : ""}${nested ? " crew-nested" : ""}`} data-kind={node.kind}>
      <span className="crew-mark" aria-hidden="true">
        {node.kind === "you" ? (
          <span className="crew-you">
            <Glyph name="person" />
          </span>
        ) : (
          <Huddler id={node.avatar.id} connector={node.avatar.connector} mood={MOOD[node.status]} size={nested ? 26 : 32} live={node.status === "running"} />
        )}
      </span>
      <div className="crew-main">
        <p className="crew-line">
          <strong>{node.name}</strong>
          <span className="crew-by">{node.by}</span>
        </p>
        {node.task && (
          <p className="crew-task">
            {node.tools.map((tool) => (
              <span key={tool} className="crew-tool" title={TOOL_TITLE[tool]}>
                <Glyph name={tool} />
              </span>
            ))}
            {node.task}
          </p>
        )}
        {node.status === "needs-you" && node.approvalId && !isRun && <AnswerButtons approvalId={node.approvalId} heldBy={heldBy} onAnswered={onChange} />}
        {node.status === "failed" && !isRun && node.error && (
          <div className="note note-error crew-error">
            <p>{node.error}</p>
            {retryError && <p role="alert">{retryError}</p>}
            {canRetry && (
              <button type="button" className="btn btn-sm btn-primary" disabled={retrying} onClick={() => void retry()}>
                {retrying ? "Trying again…" : "Try again"}
              </button>
            )}
          </div>
        )}
        {node.children.length > 0 && !isRun && (
          <button type="button" className="crew-toggle" aria-expanded={!hidden} onClick={onToggle}>
            {hidden ? `Show ${node.children.length}` : `Hide ${node.children.length}`}
          </button>
        )}
      </div>
      <div className="crew-meta">
        <span className={`badge ${label.badge}`}>{label.text}</span>
        <span className="crew-numbers">
          {node.costUsd !== null && <b>{dollars(node.costUsd)}</b>}
          {time && <span>{time}</span>}
        </span>
      </div>
      {node.children.length > 0 && !hidden && !isRun && <ol className="crew-sub">{node.children.map((child) => renderChild(child))}</ol>}
    </li>
  );
}

const TOOL_TITLE: Record<ToolMark, string> = {
  memory: "Notes from your memory",
  image: "Photos",
  web: "The web",
  sandbox: "A sandbox",
  mail: "Email",
  mic: "Your voice",
  business: "A business's agent",
  tools: "Paid tools",
};

type GlyphName = "person" | ToolMark;

const GLYPHS: Record<GlyphName, ReactNode> = {
  person: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  memory: <path d="M6 3h12v18l-6-4-6 4z" />,
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-5-5L5 21" />
    </>
  ),
  web: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20" />
    </>
  ),
  sandbox: <path d="M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8" />,
  mail: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-10 6L2 7" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0M12 17v5" />
    </>
  ),
  business: <path d="M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6" />,
  tools: <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z" />,
};

function Glyph({ name }: { readonly name: GlyphName }) {
  return (
    <svg className="crew-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {GLYPHS[name]}
    </svg>
  );
}
