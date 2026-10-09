import type { OpenShell, SandboxRequest, Store } from "@huddle/core";
import type { SandboxRequests as View, SandboxRequestView } from "./api-types.ts";

/**
 * What OpenShell sandboxes are asking for. When OpenShell blocks a connection it drafts a rule and
 * holds it for a person; this watches the gateway for those, so they land in Huddle's approvals inbox
 * next to the flows' own approvals, and decides them when the person answers. An approved rule loads
 * into the running sandbox within a few seconds (3 to 7 on gateway 0.1.2), so the agent can retry.
 */

export interface SandboxInbox {
  view(): View;
  decide(sandbox: string, id: string, yes: boolean, reason?: string): Promise<void>;
}

/** Thrown when a request is gone or changed between showing it and answering it. */
export class Stale extends Error {}

const key = (requests: readonly SandboxRequest[]) => requests.map((request) => `${request.sandbox}/${request.id}/${request.reviewToken}/${request.hits}`).join("|");

export class SandboxWatcher implements SandboxInbox {
  private readonly shell: OpenShell;
  private readonly store: Store;
  private readonly everyMs: number;
  private current: SandboxRequest[] = [];
  private error: string | null = null;
  private looked = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(shell: OpenShell, store: Store, everyMs = 3_000) {
    this.shell = shell;
    this.store = store;
    this.everyMs = everyMs;
  }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.everyMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Looks at every ready sandbox's pending rules; tells the canvas when anything changed. */
  async refresh(): Promise<void> {
    let found: SandboxRequest[];
    let error: string | null = null;
    try {
      const ready = (await this.shell.sandboxes()).filter((sandbox) => sandbox.phase === "ready");
      // A sandbox can go away between listing and asking; that one simply has nothing to ask.
      found = (await Promise.all(ready.map((sandbox) => this.shell.requests(sandbox.name).catch(() => [])))).flat();
    } catch (failure) {
      found = [];
      error = failure instanceof Error ? failure.message : String(failure);
    }
    const changed = key(found) !== key(this.current) || error !== this.error || !this.looked;
    this.current = found;
    this.error = error;
    this.looked = true;
    if (changed) this.store.events.emit("change", { kind: "sandbox" });
  }

  view(): View {
    return {
      configured: true,
      connected: this.looked && this.error === null,
      error: this.error,
      requests: this.current.map(({ reviewToken: _token, rule: _rule, ...shown }): SandboxRequestView => shown),
    };
  }

  async decide(sandbox: string, id: string, yes: boolean, reason?: string): Promise<void> {
    const request = this.current.find((candidate) => candidate.sandbox === sandbox && candidate.id === id) ?? (await this.shell.requests(sandbox).catch(() => [])).find((candidate) => candidate.id === id);
    if (!request) throw new Stale("That request isn't waiting any more.");
    try {
      if (yes) await this.shell.approve(sandbox, id, request.reviewToken);
      else await this.shell.reject(sandbox, id, reason?.trim() || "Declined in Huddle.");
    } catch (failure) {
      await this.refresh();
      const message = failure instanceof Error ? failure.message : String(failure);
      // The review token ties an approval to what was shown; if the sandbox changed since, look again.
      if (/precondition|review|changed|stale/i.test(message)) throw new Stale("It changed while you were looking. Check it again.");
      throw failure;
    }
    await this.refresh();
  }
}

/** For a Huddle without OpenShell: nothing to show, nothing to decide. */
export const noSandboxes: SandboxInbox = {
  view: () => ({ configured: false, connected: false, error: null, requests: [] }),
  decide: async () => {
    throw new Stale("Huddle isn't connected to OpenShell.");
  },
};
