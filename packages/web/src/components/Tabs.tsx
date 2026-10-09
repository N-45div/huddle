import type { KeyboardEvent, ReactNode } from "react";

interface Tab<T extends string> {
  readonly id: T;
  readonly label: ReactNode;
}

interface Props<T extends string> {
  readonly tabs: readonly Tab<T>[];
  readonly value: T;
  readonly onChange: (id: T) => void;
  readonly label: string;
  /** Prefix for the tab and panel ids (pair with TabPanel). */
  readonly idPrefix: string;
  readonly className?: string;
}

/** Tabs that follow the ARIA pattern: arrow keys move between them. */
export function Tabs<T extends string>({ tabs, value, onChange, label, idPrefix, className }: Props<T>) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((tab) => tab.id === value);
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    const tab = tabs[next];
    if (!tab) return;
    event.preventDefault();
    onChange(tab.id);
    document.getElementById(`${idPrefix}-tab-${tab.id}`)?.focus();
  };

  return (
    <div role="tablist" aria-label={label} className={className ? `tabs ${className}` : "tabs"} onKeyDown={onKeyDown}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`${idPrefix}-tab-${tab.id}`}
          aria-selected={tab.id === value}
          aria-controls={`${idPrefix}-panel-${tab.id}`}
          tabIndex={tab.id === value ? 0 : -1}
          className={tab.id === value ? "tab active" : "tab"}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ idPrefix, id, children, className }: { readonly idPrefix: string; readonly id: string; readonly children: ReactNode; readonly className?: string }) {
  return (
    <div role="tabpanel" id={`${idPrefix}-panel-${id}`} aria-labelledby={`${idPrefix}-tab-${id}`} className={className}>
      {children}
    </div>
  );
}
