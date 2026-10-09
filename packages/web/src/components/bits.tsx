import type { AnchorHTMLAttributes, ReactNode } from "react";
import { useApp } from "../app-context.ts";
import { STATE_LABEL } from "../format.ts";
import { leaveGuard } from "../router.ts";
import type { RunState } from "../types.ts";

/** An in-app link: a real <a>, which asks before leaving unsaved work. */
export function Link({ to, children, ...rest }: { readonly to: string; readonly children: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const { navigate } = useApp();
  return (
    <a
      {...rest}
      href={to}
      onClick={(event) => {
        rest.onClick?.(event);
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (leaveGuard()) {
          event.preventDefault();
          navigate(to);
        }
      }}
    >
      {children}
    </a>
  );
}

export function StateBadge({ state }: { readonly state: RunState }) {
  return <span className={`badge state-${state}`}>{STATE_LABEL[state]}</span>;
}

/** An inline error in plain words, with an optional list of problems (one per line). */
export function ErrorNote({ message, problems, onRetry }: { readonly message: string; readonly problems?: readonly string[]; readonly onRetry?: () => void }) {
  return (
    <div className="note note-error" role="alert">
      <p>{message}</p>
      {problems && problems.length > 0 && (
        <ul className="problem-list">
          {problems.map((problem, index) => (
            <li key={index}>{problem}</li>
          ))}
        </ul>
      )}
      {onRetry && (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Empty({ title, children }: { readonly title: string; readonly children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { readonly label?: string }) {
  return (
    <p className="loading" role="status">
      {label}
    </p>
  );
}

export function Hint({ children, id }: { readonly children: ReactNode; readonly id?: string }) {
  return (
    <p className="hint" id={id}>
      {children}
    </p>
  );
}

/** The one-line reminder of how templates work. */
export function TemplateHint({ id }: { readonly id?: string }) {
  return (
    <Hint id={id}>
      Fill in with <code>{"{{input}}"}</code>, <code>{"{{stepId.text}}"}</code> or <code>{"{{stepId.data.field}}"}</code>.
    </Hint>
  );
}

export function Icon({ name }: { readonly name: "flows" | "runs" | "approvals" | "memory" | "copy" | "back" | "plus" | "close" }) {
  const paths: Record<typeof name, ReactNode> = {
    flows: (
      <>
        <rect x="3" y="3" width="7" height="5" rx="1.5" />
        <rect x="14" y="16" width="7" height="5" rx="1.5" />
        <path d="M6.5 8v4.5a2 2 0 0 0 2 2h7a2 2 0 0 1 2 2V16" />
      </>
    ),
    runs: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M10 8.5v7l5.5-3.5z" />
      </>
    ),
    approvals: (
      <>
        <path d="M4 12.5l4.5 4.5L20 6" />
      </>
    ),
    memory: (
      <>
        <path d="M5 4.5h11l3 3V19.5H5z" />
        <path d="M8.5 11h7M8.5 14.5h7" />
      </>
    ),
    copy: (
      <>
        <rect x="8" y="8" width="12" height="12" rx="2" />
        <path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" />
      </>
    ),
    back: <path d="M14.5 6l-6 6 6 6" />,
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="M6 6l12 12M18 6L6 18" />,
  };
  return (
    <svg className="icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}
