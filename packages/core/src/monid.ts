/**
 * Monid (monid.ai): one key and one prepaid balance in front of a catalog of paid data tools (search
 * results, listings, reviews, prices, SEO numbers…), each a provider and an endpoint. Huddle uses it
 * for assistants that are one tool (connectors/monid.ts) and to find a tool (`huddle monid find`).
 */

export const MONID_API = "https://api.monid.ai";

/** What a tool costs, as Monid prices it: per call, per result, or set per run. */
export interface MonidPrice {
  readonly type: string;
  readonly amount?: { readonly value: number; readonly currency?: string };
}

export interface MonidTool {
  readonly provider: string;
  readonly endpoint: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly price: MonidPrice;
}

export interface MonidFound extends MonidTool {
  /** How well it fits the need, from 0 to 1. */
  readonly score: number;
}

export interface MonidDetails extends MonidTool {
  /** The input it takes, grouped as Monid takes it (body, queryParams, pathParams). */
  readonly input: unknown;
}

export interface MonidRun {
  readonly runId: string;
  /** RUNNING while a slow provider works, then COMPLETED, FAILED, BLOCKED, STOPPED or TIMED_OUT. */
  readonly status: string;
  readonly output: unknown;
  /** The provider's own HTTP status; 400 and up means it answered with an error. */
  readonly providerStatus: number;
  readonly error: string | null;
  /** What Monid charged, in US dollars (nothing for a provider error). */
  readonly costUsd: number;
}

export const FINISHED: ReadonlySet<string> = new Set(["COMPLETED", "FAILED", "BLOCKED", "STOPPED", "TIMED_OUT"]);

/** A tool's id: its provider and endpoint path, like "dataforseo/serp/google-jobs". */
export function toolId(tool: Pick<MonidTool, "provider" | "endpoint">): string {
  return `${tool.provider}${tool.endpoint.startsWith("/") ? "" : "/"}${tool.endpoint}`;
}

/** Back from an id to Monid's provider and endpoint (the endpoint keeps its leading slash). */
export function parseTool(id: string): { readonly provider: string; readonly endpoint: string } | null {
  const trimmed = id.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, slash), endpoint: trimmed.slice(slash) };
}

const SITES = /\b(linkedin|instagram|facebook|fb|twitter|tweets?|x\.com|tiktok|threads|snapchat)\b/i;
const PERSONAL = /\bpersonal[ _-](e-?mail|phone|contact)s?\b/i;
const CONTACTS = /\b(send|sends|sending)\b.{0,30}\b(sms|text messages?|e-?mails?|whatsapp|messages?)\b|\b(place|places|make|makes|making)\b.{0,20}\bcalls?\b|\b(phone|voice) calls?\b/i;

/**
 * Why Huddle won't run a tool, or null when it may: tools that scrape sites whose terms forbid it,
 * dig up people's personal contact details, or contact people (Huddle's email connector, behind
 * your approval, is the way to reach someone).
 */
export function blockedReason(tool: Pick<MonidTool, "provider" | "endpoint" | "description" | "tags">): string | null {
  const text = [tool.provider, tool.endpoint, tool.description, ...tool.tags].join(" ").replaceAll(/[/_-]+/g, " ");
  if (SITES.test(text)) return "it scrapes a site whose terms forbid scraping";
  if (PERSONAL.test(text)) return "it finds people's personal contact details";
  if (CONTACTS.test(text)) return "it contacts people";
  return null;
}

/** The input field a per-result tool reads its result count from, if it has one. */
const COUNT_FIELDS = ["maxItems", "maxResults", "maxReviews", "limit", "count", "size", "max_results", "num", "depth"] as const;
/** Results assumed when a per-result tool's input doesn't say how many. */
const ASSUMED_RESULTS = 20;

/**
 * What a run is likely to cost, in US dollars, before it starts: the per-call price, or the
 * per-result price times the results asked for. Null when Monid's pricing can't say ahead.
 */
export function estimateUsd(price: MonidPrice, input: Readonly<Record<string, unknown>> = {}): number | null {
  const value = price.amount?.value;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  if (price.type === "PER_CALL" || price.type === "TIERED") return value;
  if (price.type === "PER_RESULT") {
    const places = [input, input.body, input.queryParams].filter((place): place is Record<string, unknown> => typeof place === "object" && place !== null);
    const asked = places.flatMap((place) => COUNT_FIELDS.map((field) => place[field])).find((count) => typeof count === "number" && count > 0);
    return value * (typeof asked === "number" ? Math.min(asked, 1000) : ASSUMED_RESULTS);
  }
  return null;
}

/** The price as a person reads it: "$0.05 a run", "$0.0003 a result". */
export function priceText(price: MonidPrice): string {
  const value = price.amount?.value;
  if (typeof value !== "number") return "priced per run";
  const amount = value >= 0.01 ? `$${value.toFixed(2)}` : `$${Number(value.toPrecision(2))}`;
  if (price.type === "PER_RESULT") return `${amount} a result`;
  if (price.type === "PER_CALL" || price.type === "TIERED") return `${amount} a run`;
  return `from ${amount}, set per run`;
}

/** Monid reports costs in micro-dollars (unit MICRO_DOLLAR), or in dollars when no unit is given. */
const dollars = (value: number, unit?: string): number => (unit === "MICRO_DOLLAR" ? value / 1_000_000 : value);

function runOf(raw: unknown): MonidRun {
  const run = (raw ?? {}) as {
    runId?: string;
    status?: string;
    output?: unknown;
    reason?: string;
    providerResponse?: { httpStatus?: number; error?: { message?: string } };
    billing?: { reportedCost?: { value?: number; unit?: string } };
    cost?: { value?: number; unit?: string };
  };
  const reported = run.billing?.reportedCost ?? run.cost;
  return {
    runId: String(run.runId ?? ""),
    status: run.status ?? "RUNNING",
    output: run.output ?? null,
    providerStatus: run.providerResponse?.httpStatus ?? 200,
    error: run.providerResponse?.error?.message ?? run.reason ?? null,
    costUsd: typeof reported?.value === "number" ? Math.max(0, dollars(reported.value, reported.unit)) : 0,
  };
}

const toolOf = (raw: Partial<MonidFound> & { summary?: string }, provider = String(raw.provider ?? ""), endpoint = String(raw.endpoint ?? "")): MonidTool => ({
  provider,
  endpoint,
  description: String(raw.description ?? raw.summary ?? "").slice(0, 400),
  tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
  price: raw.price ?? { type: "UNKNOWN" },
});

export interface MonidClient {
  /** Catalog tools for a need described in words, best first. */
  find(need: string, limit?: number): Promise<MonidFound[]>;
  /** One tool's details, or null when it isn't in the catalog. */
  details(provider: string, endpoint: string): Promise<MonidDetails | null>;
  /** Runs a tool, polling a slow one until it finishes or `waitMs` passes (it's then still RUNNING). */
  run(provider: string, endpoint: string, input: Readonly<Record<string, unknown>>, options?: { readonly waitMs?: number; readonly pollMs?: number; readonly signal?: AbortSignal }): Promise<MonidRun>;
}

/** Monid with a key; errors never repeat it. */
export function monidClient(key: string, fetcher: typeof fetch = globalThis.fetch, base = MONID_API): MonidClient {
  const call = async (path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> => {
    const response = await fetcher(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...init.headers },
      signal: init.signal ?? AbortSignal.timeout(60_000),
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as unknown };
  };
  const failed = (what: string, status: number, body: unknown): Error => {
    const said = (body as { error?: unknown; message?: unknown } | null)?.error ?? (body as { message?: unknown } | null)?.message;
    return new Error(`Monid ${what} failed (HTTP ${status})${typeof said === "string" ? `: ${said.replaceAll(key, "[key]")}` : ""}`);
  };
  const status = async (runId: string, signal?: AbortSignal): Promise<MonidRun> => {
    const { status: code, body } = await call(`/v1/runs/${encodeURIComponent(runId)}`, { signal });
    if (code !== 200) throw failed("run lookup", code, body);
    return runOf(body);
  };
  return {
    async find(need, limit = 6) {
      const { status: code, body } = await call("/v1/discover", { method: "POST", body: JSON.stringify({ query: need.slice(0, 1000), limit, minScore: 0.35 }) });
      if (code !== 200) throw failed("search", code, body);
      const results = ((body as { results?: (Partial<MonidFound> & { summary?: string })[] } | null)?.results ?? []).filter((entry) => entry.provider && entry.endpoint);
      return results.map((entry) => ({ ...toolOf(entry), score: typeof entry.score === "number" ? entry.score : 0 }));
    },
    async details(provider, endpoint) {
      const { status: code, body } = await call("/v1/inspect", { method: "POST", body: JSON.stringify({ provider, endpoint }) });
      if (code === 404) return null;
      if (code !== 200 || !body) throw failed("lookup", code, body);
      const found = body as Partial<MonidFound> & { summary?: string; input?: unknown };
      return { ...toolOf(found, provider, endpoint), input: found.input ?? {} };
    },
    async run(provider, endpoint, input, { waitMs = 120_000, pollMs = 3_000, signal } = {}) {
      // A run's HTTP status mirrors its provider's, so the body decides; no run id means it never started.
      const { body } = await call("/v1/run", { method: "POST", body: JSON.stringify({ provider, endpoint, input }), signal });
      let result = runOf(body);
      if (!result.runId) {
        const said = JSON.stringify(body ?? {}).slice(0, 200).replaceAll(key, "[key]");
        throw new Error(`Monid didn't start the run: ${said}`);
      }
      const deadline = Date.now() + waitMs;
      while (!FINISHED.has(result.status) && Date.now() < deadline) {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Stopped.");
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        result = await status(result.runId, signal);
      }
      return result;
    },
  };
}
