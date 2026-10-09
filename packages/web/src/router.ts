import { useEffect, useSyncExternalStore } from "react";

/**
 * Hash routes, so the built app works from any path the server serves it on:
 *   #/flows  #/flows/:id  #/assistants  #/runs?flow=  #/runs/:id  #/approvals  #/memory
 */

export type Route =
  | { readonly name: "flows" }
  | { readonly name: "flow"; readonly id: string; readonly describe: boolean }
  | { readonly name: "runs"; readonly flow: string | null }
  | { readonly name: "run"; readonly id: string }
  | { readonly name: "assistants" }
  | { readonly name: "approvals" }
  | { readonly name: "memory" };

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const [path = "", query = ""] = raw.split("?");
  const parts = path.split("/").filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  const params = new URLSearchParams(query);
  switch (parts[0]) {
    case "flows":
      return parts[1] ? { name: "flow", id: parts[1], describe: params.has("describe") } : { name: "flows" };
    case "runs":
      return parts[1] ? { name: "run", id: parts[1] } : { name: "runs", flow: params.get("flow") };
    case "assistants":
      return { name: "assistants" };
    case "approvals":
      return { name: "approvals" };
    case "memory":
      return { name: "memory" };
    default:
      return { name: "flows" };
  }
}

const part = encodeURIComponent;

export const href = {
  flows: () => "#/flows",
  flow: (id: string, describe = false) => `#/flows/${part(id)}${describe ? "?describe" : ""}`,
  runs: (flow?: string | null) => (flow ? `#/runs?flow=${part(flow)}` : "#/runs"),
  run: (id: string) => `#/runs/${part(id)}`,
  assistants: () => "#/assistants",
  approvals: () => "#/approvals",
  memory: () => "#/memory",
};

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseRoute(hash);
}

/** Replaces the address without adding a history entry (e.g. dropping "?describe" once used). */
export function replaceHash(to: string): void {
  window.history.replaceState(null, "", to);
}

let guard: string | null = null;

/** What leaving would lose, while there is something; the app asks before navigating away. */
export function leaveGuard(): string | null {
  return guard;
}

/** While `message` is set, links in the app ask first and closing the tab warns. */
export function useLeaveGuard(message: string | null): void {
  useEffect(() => {
    guard = message;
    if (!message) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      if (guard === message) guard = null;
    };
  }, [message]);
}

export function clearLeaveGuard(): void {
  guard = null;
}
