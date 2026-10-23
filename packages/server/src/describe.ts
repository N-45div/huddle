import { type Assistant, type Flow, thinkingFor } from "@huddle/core";
import { checkFlow } from "./app.ts";

/**
 * "Describe it": a sentence in, a draft flow out, from any OpenAI-compatible chat API (OpenAI,
 * OpenRouter, a local Ollama or LM Studio). The draft is checked like any flow; if it has problems the
 * model gets one more go with the problems listed. The person still reviews it on the canvas before
 * saving, so nothing runs from a description alone.
 */

export interface DescribeOptions {
  /** The API base (e.g. https://api.openai.com/v1) or the full chat completions URL. */
  readonly url: string;
  readonly model: string;
  readonly key?: string;
  readonly fetcher?: typeof fetch;
}

const GUIDE = `You turn a description of how someone's personal assistants should work together into a Huddle flow, as JSON.

A flow:
{
  "name": "short name",
  "description": "one sentence",
  "trigger": { "type": "manual" } | { "type": "schedule", "every": "15m" | "2h" | "1d", "input": "text the run starts with" } | { "type": "schedule", "at": "18:00", "on": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] (the days it runs; leave out for every day), "timezone": "Asia/Kolkata" (when the person names a place or zone), "input": "..." } | { "type": "webhook" } | { "type": "email", "address": "the address whose mail starts it" } | { "type": "button", "input": "what a plain press starts it with" } (started from the person's Huddle button; what they say holding it is the input),
  "assistants": [ { "id": "lowercase-id", "name": "Display name", "connector": "...", "memory": ["slice", ...] } ],
  "steps": [ ... ]
}

Connectors: "openclaw" (OpenClaw), "hermes" (Hermes Agent), "sochen" (Sochen), "homeassistant" (Home Assistant, for lights, heating and devices), "agentzero" (Agent Zero, needs "url"), "a2a" (any A2A agent, needs "url"), "openai" (any OpenAI-style chat API, needs "url"), "nebius" (an NVIDIA Nemotron model on Nebius Token Factory, needs "model": "nvidia/Nemotron-3_5-Lightning" for quick answers, "nvidia/nemotron-3-super-120b-a12b" for most work, "nvidia/Nemotron-3-Ultra-550b-a55b" for hard reasoning; "thinking": true makes it think first),"tavily" (searches the web; the step's ask is the query), "contextdev" (context.dev: "agentId": "read" reads the link in the ask, and with a question in it, only the passages that answer it; "search" searches the web; "company" looks up the company behind a website, a work email or a name, with "data.found" false when there isn't one), "http" (needs "url"), "email" (sends the step's text as an email; needs "to": ["address", ...] and "from": "an address on the person's own domain"; a first line "Subject: ..." is the subject), "mock" (a stand-in with "replies": {"keyword": "answer", "*": "otherwise"}).
Use the assistants the description names. If it names none for a job, use "mock" with sensible replies so the flow can be tried, and say so in the description.
"memory" lists the slices of the person's shared memory the assistant may read, e.g. "home", "money", "work". Give each assistant only what its job needs.

Steps (each has a unique "id": lowercase letters, numbers, - and _):
- { "id": "read", "type": "agent", "agent": "<assistant id>", "ask": "what to ask, may use {{input}} and {{other-step.text}} or {{other-step.data.field}}", "next": "<step id or end>" }
- { "id": "big", "type": "condition", "if": "{{read.data.amount}} > 200", "then": "<step id>", "else": "<step id or end>" }   (operators: == != > >= < <= contains)
- { "id": "ok", "type": "approval", "message": "what the person is asked to approve", "check": true, "next": "<step id>", "onNo": "<step id or end>" }   ("check": true looks up the facts in the message on the web first; use it when the message states facts the person relies on: times, prices, places)
- { "id": "note", "type": "memory", "slice": "money", "note": "what to remember (the person approves it later)", "next": "<step id or end>" }
"next" may be left out to go to the following step. Put an approval before anything that spends money, sends messages for the person, or changes something hard to undo.

Answer with the JSON only.`;

/** The first JSON object in a reply, with or without a code fence. */
export function jsonIn(reply: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(reply)?.[1] ?? reply;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("The model didn't answer with a flow.");
  try {
    return JSON.parse(fenced.slice(start, end + 1));
  } catch {
    throw new Error("The model's flow wasn't valid JSON.");
  }
}

/** The saved assistants, one line each, for the model to pick from. */
const savedList = (saved: readonly Assistant[]): string =>
  `\n\nThe person's saved assistants. Use them for any job they fit, and in "assistants" list each one you use as just {"id": "<its id>"}: Huddle fills in the rest.\n${saved.map((assistant) => `- ${assistant.id}: ${assistant.description ?? assistant.name ?? assistant.connector}`).join("\n")}`;

/** The flow with each saved assistant it names put back exactly as saved, so a model can't change how one is reached. */
function withSaved(draft: unknown, saved: readonly Assistant[]): unknown {
  if (!draft || typeof draft !== "object" || !Array.isArray((draft as { assistants?: unknown }).assistants)) return draft;
  const byId = new Map(saved.map((assistant) => [assistant.id, assistant]));
  const assistants = (draft as { assistants: unknown[] }).assistants.map((entry) => {
    const id = entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined;
    return (typeof id === "string" && byId.get(id)) || entry;
  });
  return { ...draft, assistants };
}

export function describer(options: DescribeOptions): (text: string, saved?: readonly Assistant[]) => Promise<Flow> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const endpoint = /\/chat\/completions\/?$/.test(options.url) ? options.url : `${options.url.replace(/\/$/, "")}/chat/completions`;

  async function ask(messages: { role: string; content: string }[]): Promise<string> {
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(options.key ? { authorization: `Bearer ${options.key}` } : {}) },
      // A whole flow is worth thinking over first, where the API can (Nemotron on Token Factory).
      body: JSON.stringify({ model: options.model, messages, temperature: 0.2, ...thinkingFor(options.url, true) }),
      signal: AbortSignal.timeout(90_000),
    });
    const body = (await response.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[]; error?: { message?: string } } | null;
    if (!response.ok) {
      const said = body?.error?.message ?? `HTTP ${response.status}`;
      throw new Error(`The model said: ${options.key ? said.replaceAll(options.key, "[key]") : said}`);
    }
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("The model sent an empty answer.");
    return content;
  }

  return async (text, saved = []) => {
    const messages = [
      { role: "system", content: saved.length ? GUIDE + savedList(saved) : GUIDE },
      { role: "user", content: text },
    ];
    const first = await ask(messages);
    let checked: ReturnType<typeof checkFlow>;
    try {
      checked = checkFlow(withSaved(jsonIn(first), saved));
    } catch (error) {
      checked = { problems: [error instanceof Error ? error.message : String(error)] };
    }
    if ("flow" in checked) return checked.flow;
    const second = await ask([...messages, { role: "assistant", content: first }, { role: "user", content: `That flow has problems:\n- ${checked.problems.join("\n- ")}\nSend the whole corrected flow, JSON only.` }]);
    const retried = checkFlow(withSaved(jsonIn(second), saved));
    if ("flow" in retried) return retried.flow;
    throw new Error(`The model's flow still has problems: ${retried.problems.join("; ")}`);
  };
}
