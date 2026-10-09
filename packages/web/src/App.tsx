import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiFailure, api, onUnauthorized, readToken, writeToken } from "./api.ts";
import { AppContext, type AppContextValue, useApp } from "./app-context.ts";
import { Icon, Link } from "./components/bits.tsx";
import { ConfirmDialog, Modal } from "./components/Dialog.tsx";
import { FlowEditor } from "./editor/FlowEditor.tsx";
import { startEvents, useChanges, useStreamStatus } from "./events.ts";
import { useDebounced } from "./hooks.ts";
import { clearLeaveGuard, href, leaveGuard, type Route, useRoute } from "./router.ts";
import { ApprovalsScreen } from "./screens/ApprovalsScreen.tsx";
import { AssistantsScreen } from "./screens/AssistantsScreen.tsx";
import { ContactsScreen } from "./screens/ContactsScreen.tsx";
import { FlowsScreen } from "./screens/FlowsScreen.tsx";
import { MemoryScreen } from "./screens/MemoryScreen.tsx";
import { RunScreen } from "./screens/RunScreen.tsx";
import { RunsScreen } from "./screens/RunsScreen.tsx";
import type { Info } from "./types.ts";

export function App() {
  const route = useRoute();
  const [authVersion, setAuthVersion] = useState(0);
  const [info, setInfo] = useState<Info | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [waiting, setWaiting] = useState(0);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  const [leaveMessage, setLeaveMessage] = useState("");

  useEffect(() => onUnauthorized(() => setNeedToken(true)), []);

  const loadInfo = useCallback(async () => {
    try {
      setInfo(await api.info());
    } catch {
      // Each screen says what's wrong when it can't load; the sidebar just waits for the server.
    }
  }, []);

  useEffect(() => {
    void loadInfo();
  }, [loadInfo, authVersion]);

  // The stream carries the token only when the server asks for one.
  const streamWithToken = info ? info.auth : readToken() !== "";
  useEffect(() => startEvents(streamWithToken), [streamWithToken, authVersion]);

  // Everything waiting on the person: the flows' approvals, what OpenShell sandboxes are asking for, and PACT sign-ins.
  const refreshWaiting = useDebounced(() => {
    Promise.all([api.approvals(), api.sandboxRequests().catch(() => null), api.signIns().catch(() => [])])
      .then(([approvals, sandboxes, signIns]) => setWaiting(approvals.length + (sandboxes?.requests.length ?? 0) + signIns.length))
      .catch(() => {});
  }, 150);

  useEffect(() => {
    refreshWaiting();
  }, [refreshWaiting, authVersion]);

  useChanges((change) => {
    if (change.kind === "approval" || change.kind === "run" || change.kind === "sandbox" || change.kind === "signin" || change.kind === "resync") refreshWaiting();
    if (change.kind === "resync") void loadInfo();
  });

  const navigate = useCallback((to: string) => {
    const guard = leaveGuard();
    if (guard && to !== window.location.hash) {
      setLeaveMessage(guard);
      setLeaveTo(to);
    } else {
      window.location.hash = to;
    }
  }, []);

  const saveToken = useCallback((token: string) => {
    writeToken(token.trim());
    setNeedToken(false);
    setAuthVersion((version) => version + 1);
  }, []);

  const value = useMemo<AppContextValue>(() => ({ info, waiting, refreshWaiting, authVersion, navigate }), [info, waiting, refreshWaiting, authVersion, navigate]);

  return (
    <AppContext.Provider value={value}>
      <a className="skip-link" href="#main" onClick={(event) => {
        event.preventDefault();
        document.getElementById("main")?.focus();
      }}>
        Skip to content
      </a>
      <div className={route.name === "flow" ? "app app-wide" : "app"}>
        <Sidebar route={route} onSaveToken={saveToken} />
        <main className="main" id="main" tabIndex={-1}>
          <Screen route={route} />
        </main>
      </div>
      <TokenDialog
        open={needToken}
        onSaved={() => {
          setNeedToken(false);
          setAuthVersion((version) => version + 1);
        }}
        onClose={() => setNeedToken(false)}
      />
      <ConfirmDialog
        open={leaveTo !== null}
        title="Leave without saving?"
        confirmLabel="Leave"
        danger
        onConfirm={() => {
          clearLeaveGuard();
          const to = leaveTo;
          setLeaveTo(null);
          if (to) window.location.hash = to;
        }}
        onCancel={() => setLeaveTo(null)}
      >
        <p>{leaveMessage}</p>
      </ConfirmDialog>
    </AppContext.Provider>
  );
}

function Screen({ route }: { readonly route: Route }) {
  switch (route.name) {
    case "flows":
      return <FlowsScreen />;
    case "flow":
      return <FlowEditor key={route.id} flowId={route.id} openDescribe={route.describe} />;
    case "runs":
      return <RunsScreen flowFilter={route.flow} />;
    case "run":
      return <RunScreen key={route.id} runId={route.id} />;
    case "assistants":
      return <AssistantsScreen />;
    case "contacts":
      return <ContactsScreen />;
    case "approvals":
      return <ApprovalsScreen />;
    case "memory":
      return <MemoryScreen />;
  }
}

function Sidebar({ route, onSaveToken }: { readonly route: Route; readonly onSaveToken: (token: string) => void }) {
  const { info, waiting } = useApp();
  const status = useStreamStatus();
  const items = [
    { to: href.flows(), label: "Flows", icon: "flows", active: route.name === "flows" || route.name === "flow" },
    { to: href.assistants(), label: "Assistants", icon: "assistants", active: route.name === "assistants" },
    { to: href.contacts(), label: "Contacts", icon: "contacts", active: route.name === "contacts" },
    { to: href.runs(), label: "Runs", icon: "runs", active: route.name === "runs" || route.name === "run" },
    { to: href.approvals(), label: "Approvals", icon: "approvals", active: route.name === "approvals", badge: waiting },
    { to: href.memory(), label: "Memory", icon: "memory", active: route.name === "memory" },
  ] as const;

  return (
    <aside className="sidebar">
      <Link to={href.flows()} className="brand">
        <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
          <rect width="32" height="32" rx="8" fill="var(--accent)" />
          <circle cx="11" cy="13" r="4" fill="var(--accent-contrast)" />
          <circle cx="21" cy="13" r="4" fill="var(--accent-contrast)" />
          <path d="M6 25c1.5-4 4-6 10-6s8.5 2 10 6" stroke="var(--accent-contrast)" strokeWidth="2.5" fill="none" strokeLinecap="round" />
        </svg>
        <span>Huddle</span>
      </Link>
      <nav aria-label="Main">
        <ul className="nav">
          {items.map((item) => (
            <li key={item.label}>
              <Link to={item.to} className={item.active ? "nav-link active" : "nav-link"} aria-current={item.active ? "page" : undefined}>
                <Icon name={item.icon} />
                <span className="nav-label">{item.label}</span>
                {"badge" in item && item.badge > 0 && (
                  <span className="nav-badge" aria-label={`${item.badge} waiting`}>
                    {item.badge}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="sidebar-foot">
        <p className={`stream stream-${status}`} role="status" title="Updates from the server">
          <span className="dot" aria-hidden="true" />
          {status === "live" ? "Live" : status === "connecting" ? "Connecting…" : "Offline, retrying"}
        </p>
        {info?.auth && <TokenField onSave={onSaveToken} />}
        {info && <p className="version">Huddle {info.version}</p>}
      </div>
    </aside>
  );
}

function TokenField({ onSave }: { readonly onSave: (token: string) => void }) {
  const [value, setValue] = useState("");
  const saved = readToken() !== "";
  return (
    <form
      className="token-field"
      onSubmit={(event) => {
        event.preventDefault();
        if (!value.trim()) return;
        onSave(value);
        setValue("");
      }}
    >
      <label htmlFor="sidebar-token">Access token</label>
      <div className="token-row">
        <input id="sidebar-token" type="password" autoComplete="off" value={value} onChange={(event) => setValue(event.target.value)} placeholder={saved ? "Saved" : ""} title={saved ? "A token is saved in this browser" : undefined} />
        <button type="submit" className="btn btn-sm" disabled={!value.trim()} aria-label="Save token">
          Save
        </button>
      </div>
    </form>
  );
}

function TokenDialog({ open, onSaved, onClose }: { readonly open: boolean; readonly onSaved: () => void; readonly onClose: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setValue("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const submit = async () => {
    const token = value.trim();
    if (!token) {
      setError("Paste the token first.");
      return;
    }
    writeToken(token);
    setBusy(true);
    setError(null);
    // Try it straight away, so a typo is caught here rather than on every screen.
    try {
      await api.flows();
      onSaved();
    } catch (caught) {
      if (caught instanceof ApiFailure && (caught.status === 401 || caught.status === 403)) setError("That token didn't work. Check it and try again.");
      else onSaved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="This Huddle needs its access token"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Not now
          </button>
          <button type="submit" form="token-form" className="btn btn-primary" disabled={busy}>
            {busy ? "Checking…" : "Save token"}
          </button>
        </>
      }
    >
      <form
        id="token-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p>Paste the token this Huddle server was started with. It's kept in this browser only.</p>
        <label htmlFor="token-input">Access token</label>
        <input id="token-input" type="password" autoComplete="off" autoFocus value={value} onChange={(event) => setValue(event.target.value)} />
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
