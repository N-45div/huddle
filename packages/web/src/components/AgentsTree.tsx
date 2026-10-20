import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { type AgentNode, type AgentStatus, agentsTree, elapsed, nodesOf, type ToolMark } from "../agents-tree.ts";
import { api, describeError } from "../api.ts";
import { dollars } from "../format.ts";
import { Huddler } from "../huddlers/Huddler.tsx";
import type { HeldBy, RunDetail } from "../types.ts";
import { AnswerButtons } from "./Answer.tsx";

/**
 * Who's working on a run, live: the flow at the top, each hand-off, approval, fact check and what Huddle
 * learned under it, joined like an org chart. Each card says who, on what model, doing what, how it's going,
 * what it cost and how long it took; a card that needs you takes your yes or no, and a failed run can be tried
 * again from the step that failed.
 */
export function AgentsTree({ detail, onChange }: { readonly detail: RunDetail; readonly onChange: () => void }) {
  const root = useMemo(() => agentsTree(detail), [detail]);
  const nodes = nodesOf(root);
  const live = root.endedAt === null;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [live]);

  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const fold = (key: string) =>
    setFolded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const cards = nodes.slice(1);
  const running = nodes.filter((node) => node.status === "running");
  const needsYou = cards.filter((node) => node.status === "needs-you");
  const failedCards = cards.filter((node) => node.status === "failed");
  const failed = failedCards.length ? failedCards : root.status === "failed" ? [root] : [];
  const [showFailure, setShowFailure] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const tree = useRef<HTMLDivElement>(null);

  const showNeedsYou = () => {
    const card = tree.current?.querySelector<HTMLElement>(".agt-card.agt-needs-you:not(.agt-root)");
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.remove("agt-pulse");
    void card.offsetWidth;
    card.classList.add("agt-pulse");
  };
  const retry = async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      await api.retryRun(detail.run.id);
      setShowFailure(false);
      onChange();
    } catch (error) {
      setRetryError(describeError(error));
    } finally {
      setRetrying(false);
    }
  };

  const card = (node: AgentNode, isRoot = false) => (
    <Card
      key={node.key}
      node={node}
      root={isRoot}
      folded={folded.has(node.key)}
      onFold={() => fold(node.key)}
      onFailed={() => setShowFailure(true)}
      heldBy={detail.run.waiting?.heldBy ?? null}
      onAnswered={onChange}
    />
  );
  const columns = folded.has(root.key) ? [] : root.children;

  return (
    <section className="agt" aria-label="Agents on this run">
      <header className="agt-head">
        <h2 className="agt-title">
          <Glyph name="sparkle" /> Agents
        </h2>
        <div className="agt-counts">
          <span>{nodes.length === 1 ? "1 agent" : `${nodes.length} agents`}</span>
          {running.length > 0 && <span className="agt-count-running">{running.length} running</span>}
          {needsYou.length > 0 && (
            <button type="button" className="agt-chip agt-chip-warn" onClick={showNeedsYou}>
              {needsYou.length} needs you <Glyph name="down" />
            </button>
          )}
          {failed.length > 0 && (
            <button type="button" className="agt-chip agt-chip-danger" aria-expanded={showFailure} onClick={() => setShowFailure((open) => !open)}>
              {failed.length} failed <Glyph name={showFailure ? "up" : "down"} />
            </button>
          )}
          {root.costUsd !== null && <strong className="agt-cost">{dollars(root.costUsd)}</strong>}
        </div>
        {showFailure && failed[0] && (
          <div className="agt-pop" role="dialog" aria-label="What failed">
            <div className="agt-pop-head">
              <span className="agt-pop-icon">
                <Glyph name="warn" />
              </span>
              <p>
                <b>{failed.at(-1)!.name}</b> <span className="agt-pop-task">{failed.at(-1)!.task}</span>
              </p>
            </div>
            <p className="agt-pop-error">{failed.at(-1)!.error ?? root.error ?? "It failed."}</p>
            {retryError && (
              <p className="error-text agt-pop-error" role="alert">
                {retryError}
              </p>
            )}
            <div className="agt-pop-actions">
              <button type="button" className="agt-btn" onClick={() => setShowFailure(false)}>
                Dismiss
              </button>
              {detail.run.state === "failed" && (
                <button type="button" className="agt-btn agt-btn-dark" disabled={retrying} onClick={() => void retry()}>
                  {retrying ? "Retrying…" : "Retry"}
                </button>
              )}
            </div>
          </div>
        )}
      </header>

      <div className="agt-scroll">
        <div className="agt-tree" ref={tree}>
          {card(root, true)}
          {columns.length > 0 && (
            <ol className={columns.length === 1 ? "agt-children agt-only" : "agt-children"} style={{ "--agt-cols": columns.length } as CSSProperties}>
              {columns.map((column) => (
                <li key={column.key} className="agt-col">
                  <span className="agt-stub" aria-hidden="true" />
                  {card(column)}
                  {column.children.length > 0 && !folded.has(column.key) && (
                    <ol className="agt-stack">
                      {column.children.map((child) => (
                        <li key={child.key}>{card(child)}</li>
                      ))}
                    </ol>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}

const STATUS: Record<AgentStatus, { readonly label: string; readonly glyph: GlyphName | "spin" }> = {
  running: { label: "Running", glyph: "spin" },
  done: { label: "Done", glyph: "check" },
  "needs-you": { label: "Needs you", glyph: "clock" },
  failed: { label: "Failed", glyph: "warn" },
  stopped: { label: "Stopped", glyph: "square" },
  declined: { label: "Declined", glyph: "x" },
};

const MOOD = { running: "thinking", done: "happy", "needs-you": "waiting", failed: "oops", stopped: "sleepy", declined: "sleepy" } as const;

function Card({
  node,
  root,
  folded,
  onFold,
  onFailed,
  heldBy,
  onAnswered,
}: {
  readonly node: AgentNode;
  readonly root: boolean;
  readonly folded: boolean;
  readonly onFold: () => void;
  readonly onFailed: () => void;
  readonly heldBy: HeldBy | null;
  readonly onAnswered: () => void;
}) {
  const status = STATUS[node.status];
  const pill = (
    <>
      {status.glyph === "spin" ? <span className="agt-spin" aria-hidden="true" /> : <Glyph name={status.glyph} />}
      {status.label}
    </>
  );
  const time = elapsed(node.startedAt, node.endedAt);
  return (
    <article className={`agt-card agt-${node.status}${root ? " agt-root" : ""}`} data-kind={node.kind}>
      <div className="agt-top">
        <span className="agt-avatar">
          {node.kind === "you" ? <Glyph name="person" /> : <Huddler id={node.avatar.id} connector={node.avatar.connector} mood={MOOD[node.status]} size={26} live={node.status === "running"} />}
        </span>
        <span className="agt-name">{node.name}</span>
        {node.status === "failed" ? (
          <button type="button" className="agt-status" onClick={onFailed} title="What failed">
            {pill}
          </button>
        ) : (
          <span className="agt-status">{pill}</span>
        )}
        <span className="agt-by">{node.by}</span>
      </div>
      {node.task && (
        <p className="agt-task">
          {node.tools.length > 0 && (
            <span className="agt-tools">
              {node.tools.map((tool) => (
                <span key={tool} className="agt-tool" title={TOOL_TITLE[tool]}>
                  <Glyph name={tool} />
                </span>
              ))}
            </span>
          )}
          {node.task}
        </p>
      )}
      {node.status === "needs-you" && node.approvalId && !root && <AnswerButtons approvalId={node.approvalId} heldBy={heldBy} onAnswered={onAnswered} />}
      <div className="agt-foot">
        <span>
          {node.costUsd !== null && (
            <>
              <b>{dollars(node.costUsd)}</b>
              {time && " · "}
            </>
          )}
          {time}
        </span>
        {node.children.length > 0 && (
          <button type="button" className="agt-fold" aria-expanded={!folded} aria-label={folded ? "Show what's under it" : "Fold what's under it"} onClick={onFold}>
            {node.children.length} <Glyph name={folded ? "right" : "down"} />
          </button>
        )}
      </div>
      {node.children.length > 0 && !folded && <span className="agt-joint" aria-hidden="true" />}
    </article>
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

type GlyphName = "sparkle" | "check" | "clock" | "warn" | "square" | "x" | "down" | "up" | "right" | "person" | ToolMark;

const GLYPHS: Record<GlyphName, ReactNode> = {
  sparkle: <path d="M12 2.5l2 6.2 6.5 2.3-6.5 2.3-2 6.2-2-6.2L3.5 11 10 8.7z M19 2l.7 2.3L22 5l-2.3.7L19 8l-.7-2.3L16 5l2.3-.7z" fill="currentColor" stroke="none" />,
  check: <path d="M20 6 9 17l-5-5" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  warn: (
    <>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  square: <rect x="6" y="6" width="12" height="12" rx="2" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  down: <path d="m6 9 6 6 6-6" />,
  up: <path d="m18 15-6-6-6 6" />,
  right: <path d="m9 18 6-6-6-6" />,
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
    <svg className="agt-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {GLYPHS[name]}
    </svg>
  );
}
