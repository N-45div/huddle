import { type Assistant, AUTO, type Engine, type Flow, type Router, type StartedBy, type Store, thinkingFor } from "@huddle/core";
import { checkFlow } from "./app.ts";
import { jsonIn } from "./describe.ts";
import { answering, teamOf, type Who, whoOf, withNote, workingAt } from "./who.ts";

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

/** One assistant's job in a team's plan; `doing`, that job in a few words for the person to hear. */
export interface Part {
  readonly assistant: string;
  readonly ask: string;
  readonly doing?: string;
}

/**
 * One part of a team's plan: an assistant's job, jobs that don't need each other's answers (done at the same
 * time), or a question for you before what follows.
 */
export type TeamStep = Part | { readonly together: readonly Part[] } | { readonly approve: string };

export interface PlannerOptions {
  /** The API base (e.g. Token Factory's) or the full chat completions URL. */
  readonly url: string;
  readonly model: string;
  readonly key?: string;
  readonly fetcher?: typeof fetch;
  /** Huddle's own quick model, as Hud: ends a team's run by saying what each came back with. */
  readonly wrapUp?: Assistant;
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
{"use": "team", "say": "...", "steps": [...]}
  when it needs two or more of their assistants, each doing the part it's best at. "steps" lists the parts in order, numbered from 1; each is one of:
  {"assistant": "<id>", "ask": "...", "doing": "...", "needs": [<the numbers of earlier steps whose answers this job uses>]}
    one assistant's job. "ask" gives it its part in a sentence, said to it ("List the person's work commitments for next week."). "doing" says that job in a few words, about it, for the person to hear ("pulls your work for next week"). "needs" is [] when it uses nothing another job finds out. Jobs that don't need each other work at the same time, so the person hears back sooner.
  {"approve": "the question, e.g. Send this list to your team?"}
    right before any job that sends a message, spends money, books something or changes something hard to undo; the person answers yes or no on the button.
  At most ${MOST_TURNS} assistants' jobs in all.
  For example:
    "Plan my work week and find something fun for Saturday": the outing doesn't use the work plan, so both jobs have "needs": [].
    "Find a dinner place for Friday and invite my team to it": the invitation uses the place, so it has "needs": [1].
    "Check Saturday's weather and plan a picnic around it": the picnic uses the weather, so it has "needs": [1].

"say" is one short sentence Hud says out loud at once, before the work starts. For a flow: what it'll do. For a team: who does what, by name ("OpenClaw pulls your work for next week while Hermes finds what's on at home."). For one assistant: "".
Use only the ids listed below; never make up an assistant or a flow.`;

const described = (name: string, about: string | undefined) => (about?.trim() ? `${name}: ${about.trim()}` : name);

/** What the model is told it may choose from. */
function choicesText(choices: Choices): string {
  const flows = choices.flows.map((flow) => `- ${flow.id}: ${described(flow.name, flow.description)}`);
  const assistants = choices.assistants.map((assistant) => `- ${assistant.id}: ${described(`${assistant.name ?? assistant.id} (${assistant.connector})`, assistant.description)}`);
  return `\n\nTheir saved flows:\n${flows.join("\n") || "(none)"}\n\nTheir assistants:\n${assistants.join("\n") || "(none)"}`;
}

/** What Hud is asked at the end of a team's run: to say what each one came back with. */
function wrapAsk(turns: readonly { readonly id: string; readonly name: string }[]): string {
  return [
    "You're Hud, Huddle's own assistant. The person asked their assistants for this, and each did a part of it:",
    "{{input}}",
    ...turns.map((turn) => `\n${turn.name} came back with:\n{{${turn.id}.text}}`),
    "",
    "Tell the person what came back, by name, in one sentence for each: its answer in short, with the specifics that matter most (the first thing to do, a name, a date, a place), and anything it needs from the person. Say only what they said; if one couldn't help, say so plainly. Don't introduce yourself or open with a greeting.",
  ].join("\n");
}

/**
 * A team's plan as a flow that runs once: each assistant's part, with what was asked and what the ones before
 * it said, and each question for you where the plan put it (one with nothing after it is dropped: a yes there
 * would start nothing). The assistants are your saved ones, exactly as saved. With `wrapUp` (Huddle's own quick
 * model, as Hud), a team ends with Hud saying what each came back with, and a member who can't be reached
 * doesn't stop the rest: Hud says so.
 */
export function teamFlow(said: string, planned: readonly TeamStep[], saved: readonly Assistant[], wrapUp?: Assistant): Flow {
  const byId = new Map(saved.map((assistant) => [assistant.id, assistant]));
  const turnsIn = (step: TeamStep): number => ("together" in step ? step.together.length : "assistant" in step ? 1 : 0);
  const team = planned.reduce((sum, step) => sum + turnsIn(step), 0) > 1;
  const wrapping = team && wrapUp !== undefined;
  // Without Hud to sum up, the last one speaks for the team, so there has to be a last one: they go in order.
  const steps = wrapping ? planned : planned.flatMap((step): TeamStep[] => ("together" in step ? [...step.together] : [step]));
  const used: Assistant[] = [];
  const out: unknown[] = [];
  const done: { readonly id: string; readonly name: string }[] = [];
  // What an approval shows: the answer just before it (all of them, after several at once).
  let latest: string | null = null;
  const lastTurn = steps.findLastIndex((step) => turnsIn(step) > 0);
  // On a team, each sees the whole request, but keeps to its own lane.
  const lane = team ? " Do only this part: the rest of the team does the rest." : "";
  const member = (part: Part, id: string, earlier: string) => {
    const assistant = byId.get(part.assistant);
    if (!assistant) throw new Error(`The plan names an assistant you don't have: "${part.assistant}".`);
    if (!used.includes(assistant)) used.push(assistant);
    return { id, agent: assistant.id, ask: `${part.ask}${lane}\n\nWhat the person asked: {{input}}${earlier}`, ...(wrapping ? { optional: true } : {}), name: assistant.name ?? assistant.id };
  };
  steps.forEach((step, index) => {
    if ("approve" in step) {
      if (index > lastTurn) return;
      out.push({ id: `ok${out.length + 1}`, type: "approval", message: latest ? `${step.approve}\n\n{{${latest}.text}}` : step.approve });
      return;
    }
    // Each one sees what the ones before it came back with; those working at the same time don't see each other's.
    const earlier = done.map((turn) => `\n\nWhat ${turn.name} came back with:\n{{${turn.id}.text}}`).join("");
    const parts = "together" in step ? step.together : [step];
    // step3, or step3a, step3b... for the ones working at the same time.
    const at = out.length + 1;
    const members = parts.map((part, n) => member(part, parts.length > 1 ? `step${at}${String.fromCodePoint(97 + n)}` : `step${at}`, earlier));
    if (members.length > 1) {
      const id = `together${at}`;
      out.push({ id, type: "together", steps: members.map(({ name: _name, ...rest }) => rest) });
      latest = id;
    } else {
      const { name: _name, ...rest } = members[0]!;
      out.push({ type: "agent", ...rest });
      latest = rest.id;
    }
    for (const { id, name } of members) done.push({ id, name });
  });
  if (!done.length) throw new Error("The plan gives no assistant anything to do.");
  if (done.length > MOST_TURNS) throw new Error(`The plan has ${done.length} turns; at most ${MOST_TURNS} run from the button.`);
  if (wrapping) {
    // Hud's own id unless one of yours has it: the button shows Hud's Huddler for "hud".
    const hud = byId.has(wrapUp.id) ? { ...wrapUp, id: "huddle-hud" } : wrapUp;
    used.push(hud);
    out.push({ id: "wrap", type: "agent", agent: hud.id, ask: wrapAsk(done) });
  } else if (done.length > 1) {
    // No Hud to wrap up: the last one's answer is the one said, so it speaks for the whole team.
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

/**
 * What Hud says a team will do, from the plan as it will run: each by name with what it's doing, "while" for those
 * at the same time and "then" for one that waits ("OpenClaw pulls your week while Hermes finds Saturday, then
 * Writer drafts the invite."). Null when a job doesn't say what it's doing: the model's own sentence stands.
 */
export function planSaid(parts: readonly TeamStep[], assistants: readonly Assistant[]): string | null {
  const name = (id: string) => assistants.find((assistant) => assistant.id === id)?.name ?? id;
  const clause = (part: Part) => (part.doing ? `${name(part.assistant)} ${part.doing.replace(/[.!]+$/, "")}` : null);
  const groups: string[] = [];
  for (const part of parts) {
    if ("approve" in part) continue;
    const clauses = ("together" in part ? part.together : [part]).map(clause);
    if (clauses.some((said) => said === null)) return null;
    const all = clauses as string[];
    groups.push(all.length === 2 ? `${all[0]} while ${all[1]}` : all.length > 2 ? `${all.slice(0, -1).join(", ")} and ${all.at(-1)}, all at once` : all[0]!);
  }
  if (!groups.length) return null;
  const sentence = groups.join(", then ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

/** The model's answer as a plan, if it is one, and only over what was listed. */
export function planFrom(answer: unknown, said: string, choices: Choices, wrapUp?: Assistant): Plan {
  if (!answer || typeof answer !== "object") throw new Error("The model didn't answer with a plan.");
  const { use, id, say, steps } = answer as { use?: unknown; id?: unknown; say?: unknown; steps?: unknown };
  const spoken = typeof say === "string" ? say.trim() : "";
  if (use === "flow" && typeof id === "string" && choices.flows.some((flow) => flow.id === id)) return { use: "flow", flowId: id, say: spoken };
  if (use === "one" && typeof id === "string" && choices.assistants.some((assistant) => assistant.id === id)) return { use: "one", assistant: id, say: "" };
  if (use === "team" && Array.isArray(steps)) {
    const partOf = (value: unknown): Part | null => {
      const { assistant, ask, doing } = (value ?? {}) as { assistant?: unknown; ask?: unknown; doing?: unknown };
      if (typeof assistant !== "string" || typeof ask !== "string" || !ask.trim()) return null;
      return typeof doing === "string" && doing.trim() ? { assistant, ask: ask.trim(), doing: doing.trim() } : { assistant, ask: ask.trim() };
    };
    // Jobs that don't use each other's answers go together, so they work at the same time; one that uses the
    // answer of a job in the group (or doesn't say what it uses) waits for that group.
    const parts: TeamStep[] = [];
    let group: { readonly part: Part; readonly number: number }[] = [];
    const close = () => {
      if (group.length > 1) parts.push({ together: group.map((job) => job.part) });
      else if (group.length === 1) parts.push(group[0]!.part);
      group = [];
    };
    steps.forEach((step, index) => {
      const { approve, together, needs } = (step ?? {}) as { approve?: unknown; together?: unknown; needs?: unknown };
      if (Array.isArray(together)) {
        close();
        const members = together.flatMap((member) => partOf(member) ?? []);
        // One left on its own is just a part, done in order.
        parts.push(...(members.length > 1 ? [{ together: members }] : members));
        return;
      }
      const part = partOf(step);
      if (part) {
        const uses = Array.isArray(needs) ? needs.filter((number): number is number => typeof number === "number") : null;
        if (uses === null || uses.some((number) => group.some((job) => job.number === number))) close();
        group.push({ part, number: index + 1 });
        return;
      }
      if (typeof approve === "string" && approve.trim()) {
        close();
        parts.push({ approve: approve.trim() });
      }
    });
    close();
    const turns = parts.flatMap((part) => ("together" in part ? part.together : "assistant" in part ? [part] : []));
    // A "team" of one, with nothing to approve, is one assistant: the router answers it, quicker.
    if (turns.length === 1 && parts.length === 1) return { use: "one", assistant: turns[0]!.assistant, say: "" };
    const flow = teamFlow(said, parts, choices.assistants, wrapUp);
    return { use: "team", say: planSaid(parts, choices.assistants) ?? spoken, flow };
  }
  throw new Error(`The model's plan doesn't fit what you have: ${JSON.stringify(answer).slice(0, 200)}`);
}

export function planner(options: PlannerOptions): Planner {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const endpoint = /\/chat\/completions\/?$/.test(options.url) ? options.url : `${options.url.replace(/\/$/, "")}/chat/completions`;
  const ask = async (said: string, choices: Choices): Promise<Plan> => {
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
    if (typeof content !== "string" || !content.trim()) throw new UnreadPlan("The model sent an empty answer.");
    try {
      return planFrom(jsonIn(content), said, choices, options.wrapUp);
    } catch (error) {
      throw new UnreadPlan(error instanceof Error ? error.message : String(error));
    }
  };
  // Now and then the model's answer doesn't come back as a plan that fits: it's asked once more before giving up.
  return async (said, choices) => {
    try {
      return await ask(said, choices);
    } catch (error) {
      if (!(error instanceof UnreadPlan)) throw error;
      return ask(said, choices);
    }
  };
}

/** The model answered, but not with a plan Huddle could read. */
class UnreadPlan extends Error {}

/** What Just ask did with something said. */
export interface Asked {
  /** The plan: a saved flow, one assistant or a team; said in a sentence ("" for one assistant), with who does it, in order. */
  readonly plan: { readonly use: Plan["use"]; readonly say: string; readonly team: readonly Who[] };
  /** The run it started (a saved flow or a team), carrying on in the background; null when one assistant answered. */
  readonly run: { readonly runId: string; readonly flow: string; readonly assistant: Who | null } | null;
  /** One assistant's answer, when that was all it took. */
  readonly answer: { readonly runId: string; readonly text: string; readonly assistant: Who } | null;
}

/** A name for a team kept as a flow: the start of what was asked, cut at a word. */
function nameFor(said: string): string {
  const flat = said.replace(/\s+/g, " ").trim();
  if (flat.length <= 48) return flat || "Team";
  return `${flat.slice(0, flat.lastIndexOf(" ", 47) > 20 ? flat.lastIndexOf(" ", 47) : 47).trimEnd()}…`;
}

/**
 * Just ask, wherever it's asked from (the button, the canvas, the API, an MCP client): what was said is planned
 * over your saved flows and assistants, and started. `note` (Hud's voice note, for the button) goes to the step
 * whose answer is said, never into a saved flow. One that sees photos isn't offered: Just ask takes none.
 */
export class Asker {
  private readonly store: Store;
  private readonly engine: Engine;
  private readonly router: Router;
  private readonly planner: Planner;

  constructor(store: Store, engine: Engine, router: Router, planner: Planner) {
    this.store = store;
    this.engine = engine;
    this.router = router;
    this.planner = planner;
  }

  /** What Huddle could do with something said: your saved flows and assistants, none that look at a photo. */
  choices(): Choices {
    const sees = (assistant: { readonly images?: boolean | undefined }) => assistant.images === true;
    return {
      flows: this.store
        .flows()
        .filter((saved) => !saved.flow.assistants.some(sees))
        .map((saved) => ({ id: saved.id, name: saved.flow.name, description: saved.flow.description })),
      assistants: this.store.assistants().filter((assistant) => !sees(assistant)),
    };
  }

  async ask(said: string, by: StartedBy, options: { readonly note?: string } = {}): Promise<Asked> {
    const text = said.trim().slice(0, 4_000);
    if (!text) throw new Error("Say what you need.");
    let plan: Plan;
    try {
      plan = await this.planner(text, this.choices());
    } catch (error) {
      // No plan (the model's out, or its answer didn't fit what you have): the router's judge picks who answers.
      console.warn(`[huddle] Just ask couldn't plan, so the router answers: ${error instanceof Error ? error.message : String(error)}`);
      plan = { use: "one", assistant: AUTO, say: "" };
    }
    if (plan.use === "one") {
      const routed = await this.router.answer({ model: plan.assistant, ask: options.note ? `${options.note}\n\n${text}` : text });
      this.engine.learnFrom(routed.runId, text);
      const who = whoOf(routed.assistant) as Who;
      return { plan: { use: "one", say: "", team: [who] }, run: null, answer: { runId: routed.runId, text: routed.text, assistant: who } };
    }
    let flow = plan.use === "team" ? plan.flow : null;
    let flowId: string | null = null;
    if (plan.use === "flow") {
      const saved = this.store.flow(plan.flowId);
      if (!saved) throw new Error("That flow is gone.");
      flow = saved.flow;
      flowId = saved.id;
    }
    if (!flow) throw new Error("The plan has nothing to run.");
    const runId = this.engine.launch(options.note ? withNote(flow, options.note) : flow, text, flowId, by);
    const team = teamOf(flow);
    // The plan on the run, for the canvas to show; a team's flow as planned, for keeping it as one of yours.
    this.store.log(runId, "plan", "planned", { use: plan.use, say: plan.say, team: team.map((who) => who.id), ...(plan.use === "team" ? { flow } : {}) });
    this.engine.learnFrom(runId, text);
    return { plan: { use: plan.use, say: plan.say, team }, run: { runId, flow: flow.name, assistant: workingAt(flow, null) ?? answering(flow) }, answer: null };
  }

  /**
   * A team Just ask made, kept as a flow of yours: on the button, and starting from what you say there. Kept once:
   * asked again, it's the same flow.
   */
  keepTeam(runId: string, name?: string): { readonly id: string; readonly flow: Flow } {
    const run = this.store.run(runId);
    if (!run) throw new Error(`There's no run ${runId}.`);
    const log = this.store.logOf(runId);
    const kept = (log.find((line) => line.kind === "kept")?.detail as { flowId?: unknown } | null)?.flowId;
    const already = typeof kept === "string" ? this.store.flow(kept) : null;
    if (already) return { id: already.id, flow: already.flow };
    const planned = log.find((line) => line.kind === "planned")?.detail as { use?: unknown; flow?: unknown } | null;
    if (planned?.use !== "team" || !planned.flow || typeof planned.flow !== "object") throw new Error("Only a team that Just ask put together can be kept as a flow.");
    const checked = checkFlow({ ...(planned.flow as object), name: name?.trim().slice(0, 80) || nameFor(run.context.input), trigger: { type: "button", input: run.context.input } });
    if ("problems" in checked) throw new Error(`That team didn't make a flow: ${checked.problems.join("; ")}`);
    const saved = this.store.saveFlow(checked.flow);
    this.store.log(runId, "plan", "kept", { flowId: saved.id });
    return { id: saved.id, flow: saved.flow };
  }
}
