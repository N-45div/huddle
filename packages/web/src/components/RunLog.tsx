import type { ReactNode } from "react";
import { clockTime, fullTime, pretty } from "../format.ts";
import type { LogLine } from "../types.ts";

/**
 * A run's log, one line per thing that happened, in plain words. The engine writes:
 * started, guarded, asked, answered, checked, waiting, approved, declined, suggested and failed.
 */

function field(detail: unknown, key: string): unknown {
  return detail && typeof detail === "object" ? (detail as Record<string, unknown>)[key] : undefined;
}

function text(detail: unknown, key: string): string {
  const value = field(detail, key);
  return typeof value === "string" ? value : value === undefined || value === null ? "" : pretty(value);
}

interface Described {
  readonly title: ReactNode;
  readonly body?: string;
  readonly data?: unknown;
  readonly tone?: "ok" | "warn" | "danger";
}

function describe(line: LogLine): Described {
  const { detail } = line;
  switch (line.kind) {
    case "asked": {
      const memory = field(detail, "memory");
      const notes = Array.isArray(memory) ? memory.length : 0;
      return {
        title: (
          <>
            Asked <strong>{text(detail, "assistant") || "an assistant"}</strong>
            {notes > 0 && <span className="muted"> with {notes === 1 ? "1 kept note" : `${notes} kept notes`}</span>}
          </>
        ),
        body: text(detail, "ask"),
      };
    }
    case "answered": {
      // A business's signed receipt (PACT): say whether its signature checked out.
      const data = field(detail, "data");
      const receipt = field(data, "receipt");
      const verified = field(receipt, "verified");
      return {
        title: (
          <>
            Answered
            {receipt !== undefined && <span className={verified === true ? "receipt receipt-ok" : "receipt receipt-bad"}>{verified === true ? "signed receipt checked" : "receipt didn't check out"}</span>}
          </>
        ),
        body: text(detail, "text"),
        data,
        ...(receipt !== undefined && verified !== true ? { tone: "warn" as const } : {}),
      };
    }
    case "started": {
      const tier = text(detail, "tier");
      const via = text(detail, "via");
      return {
        title: (
          <>
            Started by <strong>{text(detail, "name") || "someone"}</strong>
            {tier && tier !== "owner" && <span className="muted"> ({tier === "stranger" ? "not in your contacts" : tier})</span>}
            {via && <span className="muted"> over {via === "a2a" ? "A2A" : via}</span>}
          </>
        ),
      };
    }
    case "guarded": {
      // ArmorIQ (or another guard) looked at the hand-off first.
      const action = text(detail, "action");
      const by = text(detail, "by") || "The guard";
      const policy = text(detail, "policy");
      const said = action === "allow" ? "let it through" : action === "hold" ? "held it for your yes" : "stopped it";
      return {
        title: (
          <>
            <strong>{by}</strong> {said}
            {policy && <span className="muted"> (policy {policy})</span>}
          </>
        ),
        body: action === "allow" ? undefined : text(detail, "reason"),
        ...(action === "block" ? { tone: "danger" as const } : action === "hold" ? { tone: "warn" as const } : {}),
      };
    }
    case "checked": {
      const result = field(detail, "result");
      return {
        title: (
          <>
            Checked <code>{text(detail, "if")}</code>: <strong>{result === true ? "yes" : result === false ? "no" : pretty(result)}</strong>
          </>
        ),
      };
    }
    case "waiting":
      return { title: "Waiting for a yes or no", body: text(detail, "message"), tone: "warn" };
    case "approved":
      return { title: "Answered yes", body: text(detail, "message"), tone: "ok" };
    case "declined":
      return { title: "Answered no", body: text(detail, "message") };
    case "suggested":
      return {
        title: (
          <>
            Suggested a note for <strong>{text(detail, "slice")}</strong>
          </>
        ),
        body: text(detail, "text"),
      };
    case "failed":
      return { title: "Failed", body: text(detail, "error"), tone: "danger" };
    default:
      return { title: line.kind, data: detail };
  }
}

export function RunLog({ log, compact = false }: { readonly log: readonly LogLine[]; readonly compact?: boolean }) {
  if (log.length === 0) return <p className="hint">Nothing has happened yet.</p>;
  return (
    <ol className={compact ? "run-log compact" : "run-log"}>
      {log.map((line, index) => {
        const described = describe(line);
        return (
          <li key={`${index}-${line.at}`} className={described.tone ? `log-line tone-${described.tone}` : "log-line"}>
            <div className="log-head">
              <span className="step-chip">{line.stepId}</span>
              <span className="log-title">{described.title}</span>
              <time className="log-time" dateTime={line.at} title={fullTime(line.at)}>
                {clockTime(line.at)}
              </time>
            </div>
            {described.body && <p className="log-body">{described.body}</p>}
            {described.data !== undefined && described.data !== null && (
              <details className="log-data">
                <summary>Data</summary>
                <pre>{pretty(described.data)}</pre>
              </details>
            )}
          </li>
        );
      })}
    </ol>
  );
}
