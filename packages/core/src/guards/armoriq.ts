import type { Guard, HandOff, Outcome, Verdict } from "../guard.ts";
import type { Assistant, Flow } from "../schema.ts";
import type { Run, RunState } from "../store.ts";

/**
 * ArmorIQ (armoriq.ai) checks every hand-off against the run's plan and your org's policy, outside any model.
 *
 * When a run reaches its first agent step, its flow's hand-offs are declared to ArmorIQ as a plan, which comes
 * back as a signed intent token. Before each hand-off Huddle asks ArmorIQ about it: one that wasn't in the plan,
 * or that your policy doesn't allow, is blocked; one your policy holds waits in Approvals for your yes.
 *
 * A hand-off is the tool `<mcp>__<connector>` (huddle__openclaw, huddle__email, ...), with the step and assistant
 * ids as its arguments. ArmorIQ never sees the ask or the answer: only which assistant each step went to, how long
 * the answer was, and how long it took.
 */

export const ARMORIQ_API = "https://api.armoriq.ai";
const DEFAULT_AGENT = "huddle";
const DEFAULT_USER = "huddle-owner";
const DEFAULT_MCP = "huddle";
/** Intent tokens last an hour; plan again a little before one runs out (a run can wait on you for days). */
const PLAN_LIFETIME_MS = 55 * 60_000;
/** Runs kept planned at once; the oldest is let go past this. */
const MAX_RUNS = 500;

interface CheckResult {
  readonly allowed: boolean;
  readonly action: string;
  readonly reason?: string;
  readonly matchedPolicy?: string;
}

/** The part of ArmorIQSession Huddle uses. */
export interface ArmorIQSessionLike {
  startPlan(toolCalls: { name: string; args: Record<string, unknown> }[], goal?: string): Promise<unknown>;
  check(toolName: string, toolArgs: Record<string, unknown>): Promise<CheckResult>;
  report(toolName: string, toolArgs: Record<string, unknown>, result: unknown, options?: { status?: "success" | "error"; errorMessage?: string; durationMs?: number }): Promise<void>;
  close(status?: "ok" | "error" | "denied"): Promise<void>;
}

/** The part of @armoriq/sdk Huddle uses. */
export interface ArmorIQSdk {
  readonly ArmorIQClient: new (options: { apiKey: string; userId: string; agentId: string }) => unknown;
  readonly ArmorIQSession: new (client: never, options: { mode: "sdk"; defaultMcpName: string; validitySeconds: number }) => ArmorIQSessionLike;
}

export interface ArmorIQOptions {
  readonly apiKey: string;
  /** The agent your ArmorIQ policies name (default "huddle"). */
  readonly agentId?: string;
  readonly userId?: string;
  /** The MCP the hand-offs are filed under (default "huddle"). */
  readonly mcp?: string;
  /** Loads the SDK; tests pass a fake. */
  readonly sdk?: () => Promise<ArmorIQSdk>;
  readonly now?: () => number;
}

/** The tool a hand-off to this assistant is, for ArmorIQ. */
export function armoriqTool(assistant: Pick<Assistant, "connector">, mcp = DEFAULT_MCP): string {
  return `${mcp}__${assistant.connector}`;
}

/** Every hand-off a flow can make, in order: the plan ArmorIQ signs. */
export function armoriqPlan(flow: Flow, mcp = DEFAULT_MCP): { name: string; args: { step: string; assistant: string } }[] {
  return flow.steps.flatMap((step) => {
    if (step.type !== "agent") return [];
    const assistant = flow.assistants.find((candidate) => candidate.id === step.agent);
    return assistant ? [{ name: armoriqTool(assistant, mcp), args: { step: step.id, assistant: assistant.id } }] : [];
  });
}

/** ArmorIQ's reason codes, said plainly. */
function plainReason(code: string, tool: string): string {
  if (code === "tool_not_in_allowlist") return `your ArmorIQ policy doesn't allow ${tool}`;
  if (code === "no_matching_policy") return `no ArmorIQ policy covers ${tool} yet (npm run huddle -- armoriq register)`;
  if (code.startsWith("tool-not-in-plan")) return `${tool} wasn't in the plan ArmorIQ signed for this run`;
  if (code === "token-expired") return "the run's ArmorIQ plan ran out";
  if (code === "allow_with_logging") return "allowed, and logged";
  return code;
}

function verdictOf(result: CheckResult, tool: string): Verdict {
  const action = result.action === "allow" || result.action === "block" || result.action === "hold" ? result.action : result.allowed ? "allow" : "block";
  const code = result.reason ?? (action === "allow" ? "allowed" : action === "hold" ? "held" : "blocked");
  return { action, reason: plainReason(code, tool), code, ...(result.matchedPolicy ? { policy: result.matchedPolicy } : {}) };
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function armoriq(options: ArmorIQOptions): Guard {
  const mcp = options.mcp ?? DEFAULT_MCP;
  const now = options.now ?? Date.now;
  const load = options.sdk ?? (async () => {
    const sdk = (await import("@armoriq/sdk")) as unknown as ArmorIQSdk & { default?: ArmorIQSdk };
    return sdk.ArmorIQClient ? sdk : sdk.default!;
  });
  let client: Promise<{ sdk: ArmorIQSdk; client: unknown }> | null = null;
  const runs = new Map<string, { session: ArmorIQSessionLike; plannedAt: number }>();

  const connect = () => {
    client ??= load().then((sdk) => ({ sdk, client: new sdk.ArmorIQClient({ apiKey: options.apiKey, userId: options.userId ?? DEFAULT_USER, agentId: options.agentId ?? DEFAULT_AGENT }) }));
    // A failed start (no SDK, bad key) is tried again on the next check rather than kept.
    client.catch(() => (client = null));
    return client;
  };

  async function sessionFor(run: Run): Promise<ArmorIQSessionLike> {
    const kept = runs.get(run.id);
    if (kept && now() - kept.plannedAt < PLAN_LIFETIME_MS) return kept.session;
    const { sdk, client: armor } = await connect();
    const session = new sdk.ArmorIQSession(armor as never, { mode: "sdk", defaultMcpName: mcp, validitySeconds: 3600 });
    await session.startPlan(armoriqPlan(run.flow, mcp), `Run the "${run.flow.name}" flow`);
    runs.delete(run.id);
    runs.set(run.id, { session, plannedAt: now() });
    if (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value!);
    return session;
  }

  const argsOf = ({ step, assistant }: HandOff) => ({ step: step.id, assistant: assistant.id });

  return {
    name: "ArmorIQ",

    async check(handOff: HandOff): Promise<Verdict> {
      const tool = armoriqTool(handOff.assistant, mcp);
      try {
        const session = await sessionFor(handOff.run);
        return verdictOf(await session.check(tool, argsOf(handOff)), tool);
      } catch (error) {
        runs.delete(handOff.run.id);
        return { action: "block", reason: `ArmorIQ couldn't check it, so it didn't go ahead: ${message(error)}`, code: "unreachable" };
      }
    },

    async report(handOff: HandOff, outcome: Outcome): Promise<void> {
      const session = runs.get(handOff.run.id)?.session;
      if (!session) return;
      try {
        await session.report(armoriqTool(handOff.assistant, mcp), argsOf(handOff), { ok: outcome.ok, chars: outcome.chars }, {
          status: outcome.ok ? "success" : "error",
          ...(outcome.error ? { errorMessage: outcome.error.slice(0, 300) } : {}),
          durationMs: outcome.ms,
        });
      } catch (error) {
        console.error(`[huddle] ArmorIQ didn't take the report for run ${handOff.run.id}: ${message(error)}`);
      }
    },

    async finish(runId: string, state: RunState): Promise<void> {
      const kept = runs.get(runId);
      if (!kept) return;
      runs.delete(runId);
      try {
        await kept.session.close(state === "done" ? "ok" : state === "failed" ? "error" : "denied");
      } catch {
        // The plan runs out on its own.
      }
    },
  };
}

export interface ArmorIQRegistration {
  readonly apiKey: string;
  readonly agentId?: string;
  readonly userId?: string;
  readonly mcp?: string;
  /** Where Huddle's MCP server is (ArmorIQ lists it; checks don't call it). */
  readonly mcpUrl: string;
  /** Connectors whose hand-offs are allowed. Anything not listed is blocked. */
  readonly allow: readonly string[];
  /** Replace a policy you've since changed on ArmorIQ's dashboard (its holds and other rules go). */
  readonly replace?: boolean;
  readonly fetcher?: typeof fetch;
}

export type RegisterResult =
  | { readonly ok: true; readonly agent: string; readonly policy: string; readonly allowed: readonly string[] }
  | { readonly ok: false; readonly conflict: boolean; readonly error: string };

/**
 * Tells ArmorIQ about Huddle, the way `armoriq register` does: the agent, the MCP its hand-offs are filed under,
 * and a policy allowing the listed connectors. Holds (ask first) are set on ArmorIQ's dashboard, and registering
 * again won't wipe them unless `replace` says to.
 */
export async function registerWithArmorIQ(registration: ArmorIQRegistration): Promise<RegisterResult> {
  const mcp = registration.mcp ?? DEFAULT_MCP;
  const body = {
    version: "v1",
    // ArmorIQ's own CLI sends the reference, not the key; the key goes in the header.
    identity: { api_key: "$ARMORIQ_API_KEY", user_id: registration.userId ?? DEFAULT_USER, agent_id: registration.agentId ?? DEFAULT_AGENT },
    environment: "production",
    mcp_servers: [{ id: mcp, url: registration.mcpUrl, auth: { type: "none" }, description: "Huddle: hand-offs between your personal assistants" }],
    policy: { allow: registration.allow.map((connector) => `${mcp}.${connector}`), deny: [] },
    intent: { ttl_seconds: 3600, require_csrg: true },
    ...(registration.replace ? { onConflict: "replace" } : {}),
  };
  const response = await (registration.fetcher ?? fetch)(`${ARMORIQ_API}/iap/sdk/register`, {
    method: "POST",
    headers: { authorization: `Bearer ${registration.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await response.json().catch(() => null)) as { message?: unknown; code?: unknown; agent?: { name?: string }; policies?: { name?: string }[] } | null;
  if (!response.ok) {
    const conflict = response.status === 409;
    const said = typeof json?.message === "string" ? json.message : `HTTP ${response.status}`;
    // ArmorIQ answers 500 when an MCP it already has is sent with a new address (seen October 2026).
    const moved = response.status >= 500 ? ` (if Huddle was registered before at another address, ArmorIQ can't move it this way: use --url with the old one, or change it under MCP Servers on ArmorIQ's dashboard)` : "";
    return { ok: false, conflict, error: conflict ? `${said} (run it with --replace to overwrite those changes)` : `${said}${moved}` };
  }
  return { ok: true, agent: json?.agent?.name ?? registration.agentId ?? DEFAULT_AGENT, policy: json?.policies?.[0]?.name ?? "", allowed: registration.allow };
}
