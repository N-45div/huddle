import { type Assistant, type Flow, thinkingFor } from "@huddle/core";
import { checkFlow } from "./app.ts";
import { jsonIn } from "./describe.ts";

/**
 * "Just ask": say anything to the button and Huddle works out who should do it. One call to a model reads what
 * was said beside your saved flows and assistants, and picks one of three: a saved flow that already does it,
 * the one assistant who can do it alone, or a team of them in order, with your OK before anything that sends,
 * spends or books. A team's flow is made from that plan as it was said (run once, never saved), so what Hud
 * tells you will happen is what runs.
 */

/** The button's first choice, before your saved flows: say anything. */
export const JUST_ASK = "just-ask";

export type Plan =
  | { readonly use: "flow"; readonly flowId: string; readonly say: string }
  | { readonly use: "one"; readonly assistant: string; readonly say: string }
  | { readonly use: "team"; readonly say: string; readonly flow: Flow };

/** What Huddle has to choose from: your saved flows, and your assistants. */
export interface Choices {
  readonly flows: readonly { readonly id: string; readonly name: string; readonly description?: string | undefined }[];
  readonly assistants: readonly Assistant[];
}

/** One part of a team's plan: an assistant's job, or a question for you before what follows. */
export type TeamStep = { readonly assistant: string; readonly ask: string } | { readonly approve: string };

export interface PlannerOptions {
  /** The API base (e.g. Token Factory's) or the full chat completions URL. */
  readonly url: string;
  readonly model: string;
  readonly key?: string;
  readonly fetcher?: typeof fetch;
}

export type Planner = (said: string, choices: Choices) => Promise<Plan>;

/** At most this many assistants' turns in a team: past it, a plan is better saved as a flow and looked over. */
const MOST_TURNS = 4;

const GUIDE = `You decide how Huddle handles what the person just said to their Huddle button. Huddle runs the person's own AI assistants as one team.

Answer with JSON only, one of:
{"use": "flow", "id": "<a saved flow's id>", "say": "..."}
  when one of their saved flows already does what they asked.
{"use": "one", "id": "<an assistant's id>", "say": ""}
  when one assistant can do all of it alone. Most questions are this.
{"use": "team", "say": "...", "steps": [{"assistant": "<id>", "ask": "..."}, {"approve": "..."}, ...]}
  when it needs two or more of their assistants, each doing the part it's best at, in order.
  Each "ask" gives that assistant its part in a sentence, said to them ("List the person's work commitments for next week."). Each one also sees what the person said and what the ones before it came back with.
  Put {"approve": "the question, e.g. Send this list to your team?"} right before any step that sends a message, spends money, books something or changes something hard to undo; the person answers yes or no on the button.
  At most ${MOST_TURNS} assistant steps. The last one tells the person what was done.

"say" is one short sentence Hud says out loud at once, before the work starts. For a team: who does what, by name ("OpenClaw will pull your work for next week, then Hermes fits in what's on at home."). For a flow: what it'll do. For one assistant: "".
Use only the ids listed below; never make up an assistant or a flow.`;

const described = (name: string, about: string | undefined) => (about?.trim() ? `${name}: ${about.trim()}` : name);

/** What the model is told it may choose from. */
function choicesText(choices: Choices): string {
  const flows = choices.flows.map((flow) => `- ${flow.id}: ${described(flow.name, flow.description)}`);
  const assistants = choices.assistants.map((assistant) => `- ${assistant.id}: ${described(`${assistant.name ?? assistant.id} (${assistant.connector})`, assistant.description)}`);
  return `\n\nTheir saved flows:\n${flows.join("\n") || "(none)"}\n\nTheir assistants:\n${assistants.join("\n") || "(none)"}`;
}

/**
 * A team's plan as a flow that runs once: each assistant's part, with what was asked and what the ones before
 * it said, and each question for you where the plan put it (one with nothing after it is dropped: a yes there
 * would start nothing). The assistants are your saved ones, exactly as saved.
 */
export function teamFlow(said: string, steps: readonly TeamStep[], saved: readonly Assistant[]): Flow {
  const byId = new Map(saved.map((assistant) => [assistant.id, assistant]));
  const used: Assistant[] = [];
  const out: unknown[] = [];
  const done: { readonly id: string; readonly name: string }[] = [];
  const lastTurn = steps.findLastIndex((step) => "assistant" in step);
  // On a team, each sees the whole request, but keeps to its own lane.
  const lane = steps.filter((step) => "assistant" in step).length > 1 ? " Do only this part: the rest of the team does the rest." : "";
  steps.forEach((step, index) => {
    if ("approve" in step) {
      if (index > lastTurn) return;
      const before = done.at(-1);
      out.push({ id: `ok${out.length + 1}`, type: "approval", message: before ? `${step.approve}\n\n{{${before.id}.text}}` : step.approve });
      return;
    }
    const assistant = byId.get(step.assistant);
    if (!assistant) throw new Error(`The plan names an assistant you don't have: "${step.assistant}".`);
    if (!used.includes(assistant)) used.push(assistant);
    const id = `step${out.length + 1}`;
    const earlier = done.map((turn) => `\n\nWhat ${turn.name} came back with:\n{{${turn.id}.text}}`).join("");
    out.push({ id, type: "agent", agent: assistant.id, ask: `${step.ask}${lane}\n\nWhat the person asked: {{input}}${earlier}` });
    done.push({ id, name: assistant.name ?? assistant.id });
  });
  if (!done.length) throw new Error("The plan gives no assistant anything to do.");
  if (done.length > MOST_TURNS) throw new Error(`The plan has ${done.length} turns; at most ${MOST_TURNS} run from the button.`);
  // The last one's answer is the one said to the person: it speaks for the whole team, not just its own part.
  if (done.length > 1) {
    const last = out.findLast((step) => (step as { type?: string }).type === "agent") as { ask: string };
    last.ask += `\n\nYou're the last of the team, and your answer is the one the person hears: first say in a few words what ${done
      .slice(0, -1)
      .map((turn) => turn.name)
      .join(" and ")} came back with (if they need something from the person, say what), then your part.`;
  }
  const checked = checkFlow({ name: "Just ask", description: said, trigger: { type: "manual" }, assistants: used, steps: out });
  if ("problems" in checked) throw new Error(`The plan didn't make a flow: ${checked.problems.join("; ")}`);
  return checked.flow;
}

/** The model's answer as a plan, if it is one, and only over what was listed. */
export function planFrom(answer: unknown, said: string, choices: Choices): Plan {
  if (!answer || typeof answer !== "object") throw new Error("The model didn't answer with a plan.");
  const { use, id, say, steps } = answer as { use?: unknown; id?: unknown; say?: unknown; steps?: unknown };
  const spoken = typeof say === "string" ? say.trim() : "";
  if (use === "flow" && typeof id === "string" && choices.flows.some((flow) => flow.id === id)) return { use: "flow", flowId: id, say: spoken };
  if (use === "one" && typeof id === "string" && choices.assistants.some((assistant) => assistant.id === id)) return { use: "one", assistant: id, say: "" };
  if (use === "team" && Array.isArray(steps)) {
    const parts = steps.flatMap((step): TeamStep[] => {
      const { assistant, ask, approve } = (step ?? {}) as { assistant?: unknown; ask?: unknown; approve?: unknown };
      if (typeof assistant === "string" && typeof ask === "string" && ask.trim()) return [{ assistant, ask: ask.trim() }];
      if (typeof approve === "string" && approve.trim()) return [{ approve: approve.trim() }];
      return [];
    });
    const turns = parts.filter((part) => "assistant" in part);
    // A "team" of one, with nothing to approve, is one assistant: the router answers it, quicker.
    if (turns.length === 1 && parts.length === 1 && "assistant" in turns[0]!) return { use: "one", assistant: turns[0]!.assistant, say: "" };
    return { use: "team", say: spoken, flow: teamFlow(said, parts, choices.assistants) };
  }
  throw new Error(`The model's plan doesn't fit what you have: ${JSON.stringify(answer).slice(0, 200)}`);
}

export function planner(options: PlannerOptions): Planner {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const endpoint = /\/chat\/completions\/?$/.test(options.url) ? options.url : `${options.url.replace(/\/$/, "")}/chat/completions`;
  return async (said, choices) => {
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(options.key ? { authorization: `Bearer ${options.key}` } : {}) },
      // Spoken to, so quick: no thinking first.
      body: JSON.stringify({
        model: options.model,
        messages: [
          { role: "system", content: GUIDE + choicesText(choices) },
          { role: "user", content: said },
        ],
        temperature: 0.1,
        max_tokens: 800,
        ...thinkingFor(options.url, false),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[]; error?: { message?: string } } | null;
    if (!response.ok) {
      const why = body?.error?.message ?? `HTTP ${response.status}`;
      throw new Error(`The model said: ${options.key ? why.replaceAll(options.key, "[key]") : why}`);
    }
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("The model sent an empty answer.");
    return planFrom(jsonIn(content), said, choices);
  };
}
