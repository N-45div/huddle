/**
 * The router's judge: given a request and your assistants, which should answer, in order. Pluggable:
 * Jev (TypeSafe AI's System One model) gives a calibrated probability for every assistant in one Choice
 * question; any OpenAI-compatible model can rank them instead; with neither, the router uses your list's
 * order. Jev is asked with the person's own key, as one ingredient of a routing decision.
 */

export interface Candidate {
  readonly id: string;
  /** What it's good at; what the judge reads. */
  readonly description: string;
}

export interface Ranking {
  readonly judge: string;
  /** Candidate ids, best first. */
  readonly order: readonly string[];
  /** Per candidate, when the judge gives them (Jev does). */
  readonly probabilities: Readonly<Record<string, number>> | null;
  /** How sure the judge is, 0 to 1, when it says. */
  readonly confidence: number | null;
  /** Which model judged (e.g. "jev-1.13.0"). */
  readonly model: string | null;
}

export interface Judge {
  readonly name: string;
  rank(request: string, candidates: readonly Candidate[]): Promise<Ranking>;
}

/** Jev's ~32k-token budget is shared by the state and the questions; keep the request well inside it. */
const MAX_STATE_CHARS = 20_000;
const INSTRUCTIONS =
  "A person sent this request to their personal assistants. Which one assistant should handle it? Pick the assistant whose description fits the request best.";

export interface JevOptions {
  readonly key: string;
  readonly model?: string;
  readonly url?: string;
  readonly fetcher?: typeof fetch;
}

export function jevJudge(options: JevOptions): Judge {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const url = options.url ?? "https://api.typesafe.ai/v1/systemone";
  return {
    name: "jev",
    async rank(request, candidates) {
      if (candidates.length > 255) throw new Error("Jev chooses among at most 255 assistants.");
      const response = await fetcher(url, {
        method: "POST",
        headers: { authorization: `Bearer ${options.key}`, "content-type": "application/json" },
        body: JSON.stringify({
          state: request.slice(0, MAX_STATE_CHARS),
          model: options.model ?? "jev-latest",
          questions: { route: { type: "choice", instructions: INSTRUCTIONS, criteria: Object.fromEntries(candidates.map((candidate) => [candidate.id, candidate.description])) } },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await response.json().catch(() => null)) as {
        model?: unknown;
        answers?: { route?: { choice?: unknown; probabilities?: Record<string, unknown>; confidence?: unknown } };
        detail?: unknown;
        error?: unknown;
      } | null;
      if (!response.ok) {
        const said = typeof body?.error === "string" ? body.error : typeof body?.detail === "string" ? body.detail : `HTTP ${response.status}`;
        throw new Error(`Jev said: ${said.replaceAll(options.key, "[key]")}`);
      }
      const answer = body?.answers?.route;
      const known = new Set(candidates.map((candidate) => candidate.id));
      const probabilities = Object.fromEntries(Object.entries(answer?.probabilities ?? {}).filter(([id, p]) => known.has(id) && typeof p === "number")) as Record<string, number>;
      const choice = typeof answer?.choice === "string" && known.has(answer.choice) ? answer.choice : null;
      if (!choice && Object.keys(probabilities).length === 0) throw new Error("Jev answered without a choice.");
      const order = [...known].sort((a, b) => (b === choice ? 1 : 0) - (a === choice ? 1 : 0) || (probabilities[b] ?? 0) - (probabilities[a] ?? 0));
      return { judge: "jev", order, probabilities, confidence: typeof answer?.confidence === "number" ? answer.confidence : null, model: typeof body?.model === "string" ? body.model : null };
    },
  };
}

export interface ModelJudgeOptions {
  /** An OpenAI-compatible API base or full chat-completions URL. */
  readonly url: string;
  readonly model: string;
  readonly key?: string;
  readonly fetcher?: typeof fetch;
}

/** Any OpenAI-compatible chat model, asked for a ranking as JSON. Not calibrated. */
export function modelJudge(options: ModelJudgeOptions): Judge {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const endpoint = /\/chat\/completions\/?$/.test(options.url) ? options.url : `${options.url.replace(/\/$/, "")}/chat/completions`;
  return {
    name: "model",
    async rank(request, candidates) {
      const list = candidates.map((candidate) => `- ${candidate.id}: ${candidate.description}`).join("\n");
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(options.key ? { authorization: `Bearer ${options.key}` } : {}) },
        body: JSON.stringify({
          model: options.model,
          temperature: 0,
          messages: [
            { role: "system", content: `${INSTRUCTIONS}\n\nAssistants:\n${list}\n\nAnswer with JSON only: {"ranking": ["best-id", "next-id", ...]} using only these ids, best first.` },
            { role: "user", content: request.slice(0, MAX_STATE_CHARS) },
          ],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await response.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[]; error?: { message?: string }; model?: unknown } | null;
      if (!response.ok) {
        const said = body?.error?.message ?? `HTTP ${response.status}`;
        throw new Error(`The judging model said: ${options.key ? said.replaceAll(options.key, "[key]") : said}`);
      }
      const content = String(body?.choices?.[0]?.message?.content ?? "");
      const json = /\{[\s\S]*\}/.exec(content)?.[0];
      const ranking = (() => {
        try {
          return (JSON.parse(json ?? "null") as { ranking?: unknown } | null)?.ranking;
        } catch {
          return undefined;
        }
      })();
      const known = candidates.map((candidate) => candidate.id);
      const picked = Array.isArray(ranking) ? ranking.filter((id): id is string => typeof id === "string" && known.includes(id)) : [];
      if (picked.length === 0) throw new Error("The judging model didn't answer with a ranking of your assistants.");
      const order = [...new Set([...picked, ...known])];
      return { judge: "model", order, probabilities: null, confidence: null, model: typeof body?.model === "string" ? body.model : options.model };
    },
  };
}
