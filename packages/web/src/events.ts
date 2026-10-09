import { useEffect, useRef, useSyncExternalStore } from "react";
import { eventsUrl } from "./api.ts";
import type { ChangeEvent } from "./types.ts";

/**
 * One event stream for the whole app (GET /api/events). Screens subscribe with useChanges and refetch
 * what they show. After the stream drops and comes back, everyone gets a "resync" so nothing that
 * changed in between is missed.
 */

export type Change = ChangeEvent | { readonly kind: "resync" };
export type StreamStatus = "connecting" | "live" | "offline";

const listeners = new Set<(change: Change) => void>();
const statusListeners = new Set<() => void>();
let status: StreamStatus = "connecting";

function setStatus(next: StreamStatus): void {
  if (next === status) return;
  status = next;
  for (const listener of statusListeners) listener();
}

function emit(change: Change): void {
  for (const listener of listeners) listener(change);
}

function isChange(value: unknown): value is ChangeEvent {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "run" || kind === "approval" || kind === "memory" || kind === "flow" || kind === "sandbox" || kind === "assistants" || kind === "contacts";
}

/** Opens the stream; returns a function that closes it. */
export function startEvents(withToken: boolean): () => void {
  let source: EventSource | null = null;
  let retry: number | undefined;
  let opened = false;
  let stopped = false;

  const onMessage = (message: MessageEvent<string>) => {
    try {
      const parsed: unknown = JSON.parse(message.data);
      if (isChange(parsed)) emit(parsed);
    } catch {
      // A line that isn't a change event is ignored.
    }
  };

  const open = () => {
    if (stopped) return;
    setStatus("connecting");
    source = new EventSource(eventsUrl(withToken));
    source.addEventListener("change", onMessage);
    source.onmessage = onMessage;
    source.onopen = () => {
      setStatus("live");
      if (opened) emit({ kind: "resync" });
      opened = true;
    };
    source.onerror = () => {
      if (!source || source.readyState !== EventSource.CLOSED) {
        setStatus("connecting");
        return;
      }
      // The browser gave up (the server refused, or isn't there): try again in a while.
      setStatus("offline");
      source.close();
      retry = window.setTimeout(open, 5000);
    };
  };

  open();
  return () => {
    stopped = true;
    window.clearTimeout(retry);
    source?.close();
    setStatus("connecting");
  };
}

/** Calls `handler` with every change; the latest handler is always used. */
export function useChanges(handler: (change: Change) => void): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    const listener = (change: Change) => ref.current(change);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
}

export function useStreamStatus(): StreamStatus {
  return useSyncExternalStore(
    (onChange) => {
      statusListeners.add(onChange);
      return () => statusListeners.delete(onChange);
    },
    () => status,
  );
}
