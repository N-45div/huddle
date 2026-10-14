import { blockedReason, type Engine, FINISHED, inputFields, type MonidField, monidClient, parseFlow, parseTool, priceText, starterInput, toolId } from "@huddle/core";

/**
 * Monid's catalog of paid data tools (monid.ai) for the canvas's tool search and for the owner's MCP
 * clients. Finding and reading a tool is free; running one goes through the engine as a one-step flow
 * ("Monid: <tool>") with a Monid assistant, so it's checked like any hand-off (the spend cap, the
 * blocklist, a guard if one is on, the budget) and shows in Runs with what it cost.
 */

export interface MonidOptions {
  /** Monid's API key (MONID_API_KEY); runs read it from the environment through the connector. */
  readonly key: string;
  /** The most one run may cost, in US dollars (HUDDLE_MONID_MAX_USD, default 0.10). */
  readonly maxUsd: number;
  /** For reaching Monid; tests pass a stand-in. */
  readonly fetcher?: typeof fetch;
}

export interface FoundTool {
  readonly tool: string;
  readonly price: string;
  readonly description: string;
  /** Why Huddle won't run it, or null. */
  readonly blocked: string | null;
}

export interface ToolDetails extends FoundTool {
  readonly fields: readonly MonidField[];
  /** An input template to start from: the first required text takes "{{ask}}". */
  readonly starter: Record<string, unknown>;
}

export interface ToolRun {
  readonly ok: boolean;
  readonly runId: string;
  readonly text: string;
  readonly costUsd: number | null;
  /** Monid's run, when the tool was still working: monid_result picks its output up later. */
  readonly pending?: string;
}

/** How long an MCP run waits for the tool: under the minute MCP clients wait by default. */
const MCP_WAIT_SECONDS = 45;

/** How much of a run's answer an MCP client is handed; the whole of it stays in the run. */
const ANSWER_LIMIT = 20_000;

export function monidCatalog(options: MonidOptions) {
  const client = monidClient(options.key, options.fetcher);
  return {
    maxUsd: options.maxUsd,

    /** A run's output once Monid has finished it. */
    result: (runId: string) => monidResult(options, runId),

    async find(need: string): Promise<FoundTool[]> {
      const found = await client.find(need.slice(0, 1000), 8);
      return found.map((tool) => ({ tool: toolId(tool), price: priceText(tool.price), description: tool.description, blocked: blockedReason(tool) }));
    },

    /** A tool's details, or null when the id isn't a tool in the catalog. */
    async show(id: string): Promise<ToolDetails | null> {
      const parsed = parseTool(id);
      if (!parsed) return null;
      const details = await client.details(parsed.provider, parsed.endpoint);
      if (!details) return null;
      return {
        tool: toolId(details),
        price: priceText(details.price),
        description: details.description,
        blocked: blockedReason(details),
        fields: inputFields(details.input),
        starter: starterInput(details.input),
      };
    },

    /** Runs a tool once, through the engine, as the owner's own request. */
    async run(engine: Engine, id: string, input: Record<string, unknown>): Promise<ToolRun> {
      const parsed = parseTool(id);
      if (!parsed) return { ok: false, runId: "", text: `"${id}" isn't a Monid tool; give it as provider/endpoint (monid_find lists them).`, costUsd: null };
      const tool = `${parsed.provider}${parsed.endpoint}`;
      const budget = engine.budget;
      if (budget && engine.spent() >= budget.usd) {
        return { ok: false, runId: "", text: `Huddle's budget ($${budget.usd} a ${budget.period}) is spent; Monid tools wait until it renews.`, costUsd: null };
      }
      const flow = parseFlow({
        name: `Monid: ${tool}`,
        assistants: [{ id: "monid", name: `Monid ${tool}`, connector: "monid", tool, maxUsd: options.maxUsd, waitSeconds: MCP_WAIT_SECONDS }],
        steps: [{ id: "reply", type: "agent", agent: "monid", ask: "{{input}}" }],
      });
      const view = await engine.start(flow, JSON.stringify(input));
      const reply = view.context.steps.reply;
      const cost = (reply?.data as { costUsd?: unknown } | undefined)?.costUsd;
      if (view.state === "done" && reply) {
        const text = reply.text.length > ANSWER_LIMIT ? `${reply.text.slice(0, ANSWER_LIMIT)}\n… (cut here; the whole answer is in Huddle's run ${view.id})` : reply.text;
        return { ok: true, runId: view.id, text, costUsd: typeof cost === "number" ? cost : null };
      }
      if (view.state === "waiting") return { ok: true, runId: view.id, text: `It's waiting for the owner's approval in Huddle (run ${view.id}).`, costUsd: null };
      // A slow tool goes on working at Monid (and is charged when it finishes): say where to pick it up.
      const pending = /still working after \d+ s \(Monid run ([\w-]+)\)/.exec(view.error ?? "")?.[1];
      if (pending) {
        return { ok: true, runId: view.id, pending, text: `Monid is still working on it. Ask monid_result for run ${pending} in a minute or two; it's charged once it finishes.`, costUsd: null };
      }
      return { ok: false, runId: view.id, text: view.error ?? `The run ended ${view.state}.`, costUsd: null };
    },
  };
}

export type MonidCatalog = ReturnType<typeof monidCatalog>;

/** A Monid run's output once it's done, for monid_result: still working, failed, or its answer. */
export async function monidResult(options: MonidOptions, runId: string): Promise<{ readonly done: boolean; readonly ok: boolean; readonly text: string; readonly costUsd: number | null }> {
  const run = await monidClient(options.key, options.fetcher).result(runId);
  if (!FINISHED.has(run.status)) return { done: false, ok: true, text: "Monid is still working on it; ask again in a minute.", costUsd: null };
  if (run.status !== "COMPLETED" || run.providerStatus >= 400) return { done: true, ok: false, text: `The run failed: ${run.error ?? run.status.toLowerCase().replaceAll("_", " ")}.`, costUsd: run.costUsd };
  const output = JSON.stringify(run.output, null, 2) ?? "null";
  return { done: true, ok: true, text: output.length > ANSWER_LIMIT ? `${output.slice(0, ANSWER_LIMIT)}\n… (cut here)` : output, costUsd: run.costUsd };
}
