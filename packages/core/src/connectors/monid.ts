import { type Connector, keyFor } from "../connector.ts";
import { blockedReason, estimateUsd, type MonidDetails, monidClient, parseTool, priceText } from "../monid.ts";
import type { Assistant } from "../schema.ts";

/**
 * One paid data tool from Monid's catalog (monid.ai) as an assistant: a Google Jobs search, a
 * reviews reader, a price lookup. The step's request is the tool's input: JSON as Monid takes it
 * ({ "body": … }, { "queryParams": … }), or plain words dropped into the assistant's input template
 * wherever it says "{{ask}}". Before each run Huddle checks the tool is one it may use and that the
 * run fits the assistant's spend cap; the answer is the tool's output, and what Monid charged goes in
 * the run's spend. Needs a Monid key, read from MONID_API_KEY unless the assistant names another
 * variable. Memory isn't sent.
 */

/** The most a run may cost when an assistant doesn't set maxUsd. */
export const DEFAULT_MAX_USD = 0.1;
/** How much of the output goes in the answer's text; all of it stays in the data. */
const TEXT_LIMIT = 8_000;
/** How long a tool's details (its price, what it does) are trusted before Huddle looks again. */
const DETAILS_TTL_MS = 10 * 60_000;

/** The template with "{{ask}}" filled in, everywhere it appears in its text. */
function filled(template: unknown, ask: string): unknown {
  if (typeof template === "string") return template === "{{ask}}" ? ask : template.replaceAll("{{ask}}", ask);
  if (Array.isArray(template)) return template.map((item) => filled(item, ask));
  if (template && typeof template === "object") return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, filled(value, ask)]));
  return template;
}

/** The run's input: the request itself when it's a JSON object, else the template with the request in it. */
export function monidInput(assistant: Assistant, ask: string): Record<string, unknown> {
  const trimmed = ask.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Not JSON after all: words for the template.
    }
  }
  if (assistant.input) return filled(assistant.input, trimmed) as Record<string, unknown>;
  throw new Error(`Assistant "${assistant.id}" needs its input as JSON (see \`huddle monid show ${assistant.tool}\`), or an input template with "{{ask}}" where the request goes.`);
}

export function monid(fetcher: typeof fetch = globalThis.fetch, timing: { readonly waitMs?: number; readonly pollMs?: number } = {}): Connector {
  const known = new Map<string, { readonly at: number; readonly details: MonidDetails | null }>();
  return {
    async send({ assistant, ask, signal }) {
      const key = keyFor(assistant, "MONID_API_KEY")!;
      const tool = parseTool(assistant.tool ?? "");
      if (!tool) throw new Error(`Assistant "${assistant.id}" uses Monid but names no tool (like "dataforseo/serp/google-jobs"); find one with \`huddle monid find\`.`);
      const id = `${tool.provider}${tool.endpoint}`;
      const client = monidClient(key, fetcher);
      try {
        const input = monidInput(assistant, ask);
        const cached = known.get(id);
        const details = cached && Date.now() - cached.at < DETAILS_TTL_MS ? cached.details : await client.details(tool.provider, tool.endpoint);
        known.set(id, { at: cached && Date.now() - cached.at < DETAILS_TTL_MS ? cached.at : Date.now(), details });
        if (!details) throw new Error(`Monid has no tool called ${id}.`);
        const blocked = blockedReason(details);
        if (blocked) throw new Error(`Huddle won't run ${id}: ${blocked}.`);
        const cap = assistant.maxUsd ?? DEFAULT_MAX_USD;
        const estimate = estimateUsd(details.price, input);
        if (estimate === null && assistant.maxUsd === undefined) {
          throw new Error(`Monid can't say what ${id} costs before it runs (${priceText(details.price)}). Give the assistant a spend cap (maxUsd) to allow it.`);
        }
        if (estimate !== null && estimate > cap) {
          throw new Error(`${id} may cost about $${estimate.toFixed(4)} (${priceText(details.price)}), over this assistant's $${cap} a run. Raise its spend cap (maxUsd) to allow it.`);
        }
        const waitMs = timing.waitMs ?? (assistant.waitSeconds ?? 120) * 1000;
        const run = await client.run(tool.provider, tool.endpoint, input, { waitMs, pollMs: timing.pollMs, signal });
        if (run.status === "RUNNING") throw new Error(`${id} is still working after ${Math.round(waitMs / 1000)} s (Monid run ${run.runId}); a slower tool needs a longer wait (waitSeconds).`);
        if (run.status !== "COMPLETED" || run.providerStatus >= 400) throw new Error(`${id} failed: ${run.error ?? run.status.toLowerCase().replaceAll("_", " ")}.`);
        const output = JSON.stringify(run.output, null, 2) ?? "null";
        const cost = run.costUsd > 0 ? ` (Monid charged $${Number(run.costUsd.toPrecision(3))})` : "";
        const text = `${id} answered${cost}:\n\n${output.length > TEXT_LIMIT ? `${output.slice(0, TEXT_LIMIT)}\n… (cut here; the full output is in the step's data)` : output}`;
        return {
          text,
          data: { tool: id, run: run.runId, costUsd: run.costUsd, output: run.output },
          usage: { inputTokens: 0, outputTokens: 0, costUsd: run.costUsd },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(message.replaceAll(key, "[key]"));
      }
    },
  };
}
