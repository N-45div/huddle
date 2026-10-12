import type { Guard, HandOff, Verdict } from "../guard.ts";

/**
 * Bring your own guard: before each hand-off, Huddle POSTs it to your policy service (OPA behind a small
 * adapter, a script, a company gateway) and does what it answers. A hold waits in Huddle's own Approvals.
 * The service sees which assistant a step goes to and who started the run, never what was asked or answered.
 *
 *   POST <url>   { "flow": "...", "run": "run_...", "step": "send", "assistant": "mailer", "connector": "email" }
 *   200          { "action": "allow" | "block" | "hold", "reason": "..." }
 */

export interface HttpGuardOptions {
  readonly url: string;
  /** Sent as a Bearer token, when your service wants one. */
  readonly key?: string;
  /** What to do when the service can't be reached or answers nonsense: "block" (default) or "allow". */
  readonly onFailure?: "block" | "allow";
  readonly fetcher?: typeof fetch;
}

const ACTIONS = new Set(["allow", "block", "hold"]);

export function httpGuard(options: HttpGuardOptions): Guard {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const host = (() => {
    try {
      return new URL(options.url).host;
    } catch {
      throw new Error(`HUDDLE_GUARD_URL isn't a web address: "${options.url}".`);
    }
  })();
  const failed = (why: string): Verdict =>
    options.onFailure === "allow" ? { action: "allow", reason: `${host} couldn't be asked (${why}), and you let hand-offs through then`, code: "unreachable" } : { action: "block", reason: `${host} couldn't be asked, so it didn't go ahead: ${why}`, code: "unreachable" };

  return {
    name: "Your guard",
    async check({ run, step, assistant }: HandOff): Promise<Verdict> {
      let response: Response;
      try {
        response = await fetcher(options.url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(options.key ? { authorization: `Bearer ${options.key}` } : {}) },
          body: JSON.stringify({ flow: run.flow.name, run: run.id, step: step.id, assistant: assistant.id, connector: assistant.connector }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        return failed(error instanceof Error ? error.message : String(error));
      }
      const body = (await response.json().catch(() => null)) as { action?: unknown; reason?: unknown } | null;
      if (!response.ok) return failed(`HTTP ${response.status}`);
      if (typeof body?.action !== "string" || !ACTIONS.has(body.action)) return failed('its answer had no "action" of allow, block or hold');
      const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 300) : body.action === "allow" ? "allowed" : body.action === "hold" ? "it wants your yes first" : "not allowed";
      return { action: body.action as Verdict["action"], reason };
    },
    async report() {},
    async finish() {},
  };
}
