import { askFirst, type Caller, callerDecision, type Change, type Engine, type Run, type SavedFlow, type Store } from "@huddle/core";
import { bearerOf, same } from "./auth.ts";

/**
 * Who is calling Huddle from outside, and starting a flow for them. A2A and MCP share this, so a
 * flow's callers rule, the approval in front for "ask", and who may read which run work the same way
 * whichever protocol a caller speaks.
 */

const TIER_WORDS: Readonly<Record<string, string>> = { owner: "you", partner: "your partner", family: "family", friend: "friends", contact: "contacts" };

/** You (Huddle's token, or anyone when Huddle has no token), a contact (their own token), or a stranger. */
export function callerOf(store: Store, ownerToken: string | undefined, authorization: string | undefined): Caller {
  const bearer = bearerOf(authorization);
  if (!ownerToken || (bearer && same(bearer, ownerToken))) return { tier: "owner", name: "You", contactId: null };
  const contact = bearer ? store.contactByToken(bearer) : null;
  return contact ? { tier: contact.tier, name: contact.name, contactId: contact.id } : { tier: "stranger", name: "Someone not in your contacts", contactId: null };
}

/** Who started a run, as it's kept: "owner", a contact's id, or "stranger". */
export const callerKey = (caller: Caller): string => (caller.tier === "owner" ? "owner" : (caller.contactId ?? "stranger"));

/** You read every run started from outside; anyone else only the ones they started. */
export const mayRead = (startedBy: string, caller: Caller): boolean => caller.tier === "owner" || startedBy === callerKey(caller);

/** What a caller the flow turns away is told. */
export function refusal(saved: SavedFlow): string {
  const starts = saved.flow.callers?.starts ?? "owner";
  return `"${saved.flow.name}" takes requests only from ${TIER_WORDS[starts] ?? starts}${starts === "owner" ? "" : " and closer"}.`;
}

/**
 * Starts a saved flow for someone outside, by its callers rule: closer tiers start it at once, the rest
 * wait for your OK (an approval in front saying who wants it and with what), and the turned-away get
 * null. The run's log starts with who started it and how (`via`).
 */
export function startFor(engine: Engine, saved: SavedFlow, input: string, caller: Caller, via: string): string | null {
  const decision = callerDecision(saved.flow.callers, caller.tier);
  if (decision === "refuse") return null;
  const who = caller.tier === "owner" || caller.tier === "stranger" ? caller.name : `${caller.name} (${caller.tier})`;
  const flow = decision === "ask" ? askFirst(saved.flow, who) : saved.flow;
  return engine.launch(flow, input.slice(0, 100_000), saved.id, { name: caller.name, tier: caller.tier, via });
}

/** Waits until a run is no longer running (done, failed, declined, or waiting on a person), or `ms` passes. */
export function settled(store: Store, runId: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const onChange = (change: Change) => {
      if (change.kind === "run" && change.runId === runId) check();
    };
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      store.events.off("change", onChange);
      resolve();
    }
    function check() {
      if (store.run(runId)?.state !== "running") finish();
    }
    store.events.on("change", onChange);
    check();
  });
}

/** What a finished run answered: its last answer (or suggested note), else "Done.". */
export function answerOf(store: Store, run: Run): { readonly text: string; readonly data: unknown } {
  const answered = store.logOf(run.id).findLast((line) => line.kind === "answered" || line.kind === "suggested");
  const detail = (answered?.detail ?? null) as { text?: unknown; data?: unknown } | null;
  return { text: typeof detail?.text === "string" ? detail.text : "Done.", data: detail?.data };
}
