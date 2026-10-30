import { evaluate } from "./condition.ts";
import { type Connector, memoryText, type Reply } from "./connector.ts";
import { type Budget, budgetName, dollars, periodStart, priceOf, spendOf } from "./cost.ts";
import { amountText, expired, keyText, parseSignable, type Payment, signableId, signableLine, signableText, signableTime, signedBy } from "./countersign.ts";
import type { FactCheck, FactChecker } from "./factcheck.ts";
import type { AgentStep, Guard } from "./guard.ts";
import { alreadySays, type Learner } from "./memory/learn.ts";
import { Memory } from "./memory/memory.ts";
import { type Assistant, type Flow, type Step, turnAt } from "./schema.ts";
import { cartLines, type ShopClient, shopClient, ShopError, type ShopOrder } from "./shop.ts";
import type { Approval, Note, Run, SignRequest, Store } from "./store.ts";

/** The setting that turns learning from what you say on ("on") or off. */
export const LEARNING = "memory.learn";
import { type RunContext, render } from "./template.ts";

/**
 * Runs flows. A run goes step by step, saving after each one; at an approval it saves and stops, and
 * `decide` picks it up again later, from a fresh process if need be, since everything is in the store.
 */

/** A loop in a flow can't spin forever: a run stops after this many steps. */
export const MAX_STEPS = 100;
/** How long a payment waits for your board's signature before it has to be asked for again. */
export const PAY_MINUTES = 10;

export interface RunView {
  readonly id: string;
  readonly flowId: string | null;
  readonly state: Run["state"];
  readonly at: string | null;
  readonly error: string | null;
  /** What the run is waiting on, when it is; heldBy when only a guard's own approver can say yes, signs when only your board's signature can. */
  readonly waiting: Pick<Approval, "id" | "message" | "heldBy" | "signs"> | null;
  readonly context: RunContext;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Who started a run from outside, and how: the first line of its log. */
export interface StartedBy {
  readonly name: string;
  readonly tier: string;
  /** "a2a", "email", ... */
  readonly via: string;
}

export interface EngineOptions {
  /** Picks the notes each agent step sends (default: found by their words, within Sochen's budget). */
  readonly memory?: Memory;
  /** Looks at each hand-off before it's made (ArmorIQ); none by default. */
  readonly guard?: Guard;
  /** A cap on what hand-offs to paid assistants may spend; none by default. */
  readonly budget?: Budget | null;
  /** Checks the facts in an approval's message on the web, for steps that ask (`check: true`); none by default. */
  readonly checker?: FactChecker;
  /** Suggests notes from what you said in runs you start yourself, once you turn learning on; none by default. */
  readonly learner?: Learner;
  /** How pay steps reach a shop, by its address (default: over HTTP); tests pass a stand-in. */
  readonly shops?: (url: string) => ShopClient;
  readonly now?: () => number;
}

/** A hand-off to a paid assistant when the budget is spent. */
export class OverBudget extends Error {}

/** A yes for a hand-off that only its guard's approver can release. */
export class HeldElsewhere extends Error {
  readonly url: string;
  constructor(by: string, url: string) {
    super(`${by} holds this one: approve it in ${by} (${url}), and the run carries on by itself. You can still say no here.`);
    this.url = url;
  }
}

/** A yes for a payment, which only your board's signature can give. */
export class NeedsSignature extends Error {
  constructor() {
    super("This payment needs your board's signature: hold the button on your board, or sign it on the virtual board in Devices. You can still say no here.");
  }
}

export class Engine {
  readonly store: Store;
  readonly connectors: Readonly<Record<string, Connector>>;
  readonly memory: Memory;
  readonly guard: Guard | null;
  readonly budget: Budget | null;
  readonly checker: FactChecker | null;
  readonly learner: Learner | null;
  private readonly shops: (url: string) => ShopClient;
  private readonly now: () => number;
  /** Runs to learn from once they end, with what the person said. */
  private readonly toLearn = new Map<string, string>();

  constructor(store: Store, connectors: Readonly<Record<string, Connector>>, options: EngineOptions = {}) {
    this.store = store;
    this.connectors = connectors;
    this.memory = options.memory ?? new Memory(store);
    this.guard = options.guard ?? null;
    this.budget = options.budget ?? null;
    this.checker = options.checker ?? null;
    this.learner = options.learner ?? null;
    this.shops = options.shops ?? ((url) => shopClient(url));
    this.now = options.now ?? Date.now;
  }

  /** What hand-offs with a known cost have spent in the budget's period (this month without one). */
  spent(): number {
    const since = periodStart(this.budget?.period ?? "month").toISOString();
    return this.store.spendSince(since).reduce((sum, total) => sum + total.usd, 0);
  }

  async start(flow: Flow, input: string, flowId: string | null = null, startedBy?: StartedBy, images: readonly string[] = []): Promise<RunView> {
    const run = this.store.createRun(flow, input, flowId, images);
    if (startedBy) this.store.log(run.id, "trigger", "started", startedBy);
    return this.advance(run, flow.steps[0]?.id ?? "end");
  }

  /** Starts a run and returns its id at once; the run carries on in the background (for the server). */
  launch(flow: Flow, input: string, flowId: string | null = null, startedBy?: StartedBy, images: readonly string[] = []): string {
    const run = this.store.createRun(flow, input, flowId, images);
    if (startedBy) this.store.log(run.id, "trigger", "started", startedBy);
    void this.advance(run, flow.steps[0]?.id ?? "end").catch((error: unknown) => console.error(`[huddle] run ${run.id} stopped:`, error));
    return run.id;
  }

  /**
   * Tries a failed run's failed step again and carries on from there, in the background. The earlier try stays
   * in the log, so the run shows it stopped and the new one under way. Throws straight away if it can't.
   */
  retry(runId: string): string {
    const run = this.store.run(runId);
    if (!run) throw new Error(`There's no run ${runId}.`);
    if (run.state !== "failed" || !run.at) throw new Error("Only a run that failed at one of its steps can be tried again.");
    this.store.log(run.id, run.at, "retried", {});
    void this.advance(run, run.at).catch((error: unknown) => console.error(`[huddle] retrying run ${run.id}:`, error));
    return run.id;
  }

  /** Answers an approval and returns at once; the run carries on in the background. Throws straight away if it can't be answered. */
  answer(approvalId: string, yes: boolean): string {
    const approval = this.store.approval(approvalId);
    if (!approval) throw new Error(`There's no approval ${approvalId}.`);
    if (approval.status !== "waiting") throw new Error(`Approval ${approvalId} was already answered (${approval.status}).`);
    if (yes && approval.heldBy) throw new HeldElsewhere(approval.heldBy.by, approval.heldBy.url);
    if (yes && approval.signs) throw new NeedsSignature();
    void this.decide(approvalId, yes).catch((error: unknown) => console.error(`[huddle] approval ${approvalId}:`, error));
    return approval.runId;
  }

  /** Takes your board's signature of a payment and returns at once; the run carries on in the background. Throws straight away if it isn't taken. */
  sign(signId: string, signature: string, key: string): string {
    const request = this.signable(signId, signature, key);
    const late = expired(parseSignable(request.text), this.now());
    // An expired one still goes through countersign, which fails its step so the run can ask again.
    void this.countersign(signId, signature, key).catch((error: unknown) => console.error(`[huddle] signature for ${signId}:`, error));
    if (late) throw new Error(`That payment expired before it was signed (it waits ${PAY_MINUTES} minutes). Try the run again to be asked again.`);
    return request.runId ?? "";
  }

  /**
   * Takes your board's signature of a payment a pay step is waiting on, and carries the run on to the shop's
   * checkout. Taken only from a board you've added, of exactly the text it was shown, before it expires; a
   * payment that expired fails its step, so trying the run again asks your board again.
   */
  async countersign(signId: string, signature: string, key: string): Promise<RunView> {
    const request = this.signable(signId, signature, key);
    const approval = this.store.approvalForSign(signId);
    if (!approval) throw new Error("Nothing is waiting on that payment's signature any more.");
    if (expired(parseSignable(request.text), this.now())) {
      this.store.moveSignRequest(signId, "waiting", { status: "expired" });
      this.store.decide(approval.id, false);
      const run = this.store.run(approval.runId)!;
      return this.fail(run.id, approval.stepId, run.context, `The payment expired before your board signed it (it waits ${PAY_MINUTES} minutes). Try the run again to be asked again.`);
    }
    const board = this.store.signer(keyText(key))!;
    if (!this.store.markSigned(signId, signature, board.key)) throw new Error("That payment was already signed or answered.");
    this.store.log(approval.runId, approval.stepId, "signed", { sign: signId, by: board.name, board: board.fingerprint });
    return this.decide(approval.id, true, { signed: true });
  }

  /** The waiting payment a signature is for, once it's checked: one of your boards', of exactly its text. */
  private signable(signId: string, signature: string, key: string): SignRequest {
    const request = this.store.signRequest(signId);
    if (!request || request.kind !== "buy") throw new Error(`There's no payment ${signId} waiting to be signed.`);
    if (request.status !== "waiting") throw new Error(`That payment was already ${request.status}.`);
    let board;
    try {
      board = this.store.signer(keyText(key));
    } catch {
      board = null;
    }
    if (!board) throw new Error("That key isn't one of your boards'. Add the board in Devices first.");
    if (!signedBy(request.text, signature, board.key)) throw new Error("That isn't your board's signature of this payment, so it wasn't taken.");
    return request;
  }

  /**
   * Answers an approval and carries its run on: yes goes to `next`, no to `onNo` or ends the run as declined.
   * A hand-off held by a guard's own approver takes a yes only from there (`released`), and a payment only from
   * your board's signature (`signed`); a no works anywhere.
   */
  async decide(approvalId: string, yes: boolean, options: { readonly released?: boolean; readonly signed?: boolean } = {}): Promise<RunView> {
    const approval = this.store.approval(approvalId);
    if (!approval) throw new Error(`There's no approval ${approvalId}.`);
    if (yes && approval.heldBy && !options.released) throw new HeldElsewhere(approval.heldBy.by, approval.heldBy.url);
    if (yes && approval.signs && !options.signed) throw new NeedsSignature();
    const run = this.store.run(approval.runId);
    if (!run) throw new Error(`The run for approval ${approvalId} is gone.`);
    if (!this.store.decide(approvalId, yes)) throw new Error(`Approval ${approvalId} was already answered (${approval.status}).`);
    // A hand-off the guard held (an agent step, or one of a together step's): yes makes it, without asking the
    // guard again; no ends the run.
    const turn = turnAt(run.flow, approval.stepId);
    if (turn) {
      this.store.log(run.id, turn.id, yes ? "approved" : "declined", { message: approval.message });
      if (yes) return this.advance(run, turn.group ?? turn.id, turn.id);
      return this.end(run.id, "declined", null, run.context, null);
    }
    const step = run.flow.steps.find((candidate) => candidate.id === approval.stepId);
    // A payment: signed, the run goes on to the shop's checkout; no, it goes to onNo or ends as declined.
    if (step?.type === "pay") {
      if (yes) return this.advance(run, step.id);
      if (approval.signs) this.store.moveSignRequest(approval.signs, "waiting", { status: "declined" });
      this.store.log(run.id, step.id, "declined", { message: approval.message });
      const context: RunContext = { ...run.context, steps: { ...run.context.steps, [step.id]: { text: "no", data: { paid: false } } } };
      if (step.onNo) return this.advance({ ...run, context }, step.onNo);
      return this.end(run.id, "declined", null, context, null);
    }
    if (!step || step.type !== "approval") throw new Error(`Approval ${approvalId} points at a step that isn't an approval.`);
    this.store.log(run.id, step.id, yes ? "approved" : "declined", { message: approval.message });
    const context: RunContext = { ...run.context, steps: { ...run.context.steps, [step.id]: { text: yes ? "yes" : "no", data: yes } } };
    if (yes) return this.advance({ ...run, context }, step.next ?? following(run.flow, step));
    if (step.onNo) return this.advance({ ...run, context }, step.onNo);
    return this.end(run.id, "declined", null, context, null);
  }

  view(runId: string): RunView {
    const run = this.store.run(runId);
    if (!run) throw new Error(`There's no run ${runId}.`);
    const waiting = run.state === "waiting" ? this.store.waitingApproval(run.id) : null;
    return {
      id: run.id,
      flowId: run.flowId,
      state: run.state,
      at: run.at,
      error: run.error,
      waiting: waiting ? { id: waiting.id, message: waiting.message, heldBy: waiting.heldBy, signs: waiting.signs } : null,
      context: run.context,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  }

  /** `cleared` is a held hand-off you've just said yes to: it's made without asking the guard again. */
  private async advance(run: Run, from: string, cleared: string | null = null): Promise<RunView> {
    let context = run.context;
    let target = from;
    // Carrying on after an approval, or starting: say which step is under way now, not after it (an assistant can
    // take minutes).
    if ((run.state !== "running" || run.at === null) && target !== "end") this.store.saveRun({ id: run.id, state: "running", at: target, context, error: null });
    const done = Object.keys(context.steps).length;
    for (let count = done; ; count += 1) {
      if (target === "end") return this.end(run.id, "done", null, context, null);
      const step = run.flow.steps.find((candidate) => candidate.id === target);
      if (!step) return this.fail(run.id, target, context, `There's no step "${target}".`);
      if (count >= MAX_STEPS) return this.fail(run.id, step.id, context, `Stopped after ${MAX_STEPS} steps; the flow probably loops.`);
      try {
        const outcome = await this.runStep(run, step, context, cleared);
        if (outcome.wait) {
          this.store.saveRun({ id: run.id, state: "waiting", at: step.id, context, error: null });
          return this.view(run.id);
        }
        context = outcome.context;
        target = outcome.next;
        this.store.saveRun({ id: run.id, state: "running", at: target === "end" ? null : target, context, error: null });
      } catch (error) {
        return this.fail(run.id, step.id, context, error instanceof Error ? error.message : String(error));
      }
    }
  }

  private async runStep(run: Run, step: Step, context: RunContext, cleared: string | null = null): Promise<{ wait: true } | { wait: false; context: RunContext; next: string }> {
    const keep = (text: string, data?: unknown): RunContext => ({ ...context, steps: { ...context.steps, [step.id]: data === undefined ? { text } : { text, data } } });
    switch (step.type) {
      case "agent": {
        const ready = await this.clear(run, step, cleared === step.id);
        if (!ready) return { wait: true };
        const answer = await this.handOff(run, ready, context);
        return { wait: false, context: keep(answer.text, answer.data), next: step.next ?? following(run.flow, step) };
      }
      case "together": {
        // Each one is cleared first (a guard may hold one for your yes, which then stands for the whole run);
        // then they're all asked at once, and the run goes on when every one is done.
        const said = new Set(this.store.logOf(run.id).flatMap((line) => (line.kind === "approved" || line.kind === "released" ? [line.stepId] : [])));
        if (cleared) said.add(cleared);
        const ready: Ready[] = [];
        for (const member of step.steps) {
          const one = await this.clear(run, { ...member, type: "agent" }, said.has(member.id));
          if (!one) return { wait: true };
          ready.push(one);
        }
        // Each one finishing is news for the canvas and the button: who's still at it changes.
        const settled = await Promise.allSettled(ready.map((one) => this.handOff(run, one, context).finally(() => this.store.runMoved(run.id))));
        const failed = settled.findIndex((outcome) => outcome.status === "rejected");
        if (failed >= 0) {
          // The run fails at the together step; the run page shows which of them it was.
          const member = ready[failed]!;
          const why = (settled[failed] as PromiseRejectedResult).reason;
          const error = why instanceof Error ? why.message : String(why);
          this.store.log(run.id, member.step.id, "failed", { error });
          throw new Error(`${member.assistant.name ?? member.assistant.id} couldn't do its part: ${error}`);
        }
        const answers = settled.map((outcome) => (outcome as PromiseFulfilledResult<Answer>).value);
        const steps = { ...context.steps };
        ready.forEach((one, index) => {
          const answer = answers[index]!;
          steps[one.step.id] = answer.data === undefined ? { text: answer.text } : { text: answer.text, data: answer.data };
        });
        // All of them by name, for a step after that wants the lot.
        steps[step.id] = { text: ready.map((one, index) => `${one.assistant.name ?? one.assistant.id}:\n${answers[index]!.text}`).join("\n\n") };
        return { wait: false, context: { ...context, steps }, next: step.next ?? following(run.flow, step) };
      }
      case "condition": {
        const result = evaluate(step.if, context);
        this.store.log(run.id, step.id, "checked", { if: render(step.if, context), result });
        return { wait: false, context: keep(String(result), result), next: result ? step.then : step.else };
      }
      case "approval": {
        const message = render(step.message, context);
        const checks = step.check ? await this.checkFacts(run, step.id, message) : null;
        const approval = this.store.addApproval(run.id, step.id, message, null, checks);
        this.store.log(run.id, step.id, "waiting", { approval: approval.id, message });
        return { wait: true };
      }
      case "pay":
        return this.pay(run, step, context);
      case "memory": {
        const note = render(step.note, context);
        const source = `run ${run.id}, step ${step.id}`;
        const suggested = this.store.suggest(step.slice, note, source);
        // A note memory already holds comes back as it is, not suggested again.
        const already = suggested.source !== source ? suggested.status : null;
        this.store.log(run.id, step.id, "suggested", { note: suggested.id, slice: step.slice, text: suggested.note, ...(already ? { already } : {}) });
        return { wait: false, context: keep(note), next: step.next ?? following(run.flow, step) };
      }
    }
  }

  /**
   * Whether a hand-off may go ahead: its assistant and connector found, the guard asked (unless you've said yes
   * to it already in this run) and the budget checked. Null when the guard held it: your approval is filed.
   */
  private async clear(run: Run, step: AgentStep, cleared: boolean): Promise<Ready | null> {
    const assistant = run.flow.assistants.find((candidate) => candidate.id === step.agent);
    if (!assistant) throw new Error(`Step "${step.id}" asks "${step.agent}", which isn't one of the flow's assistants.`);
    const connector = this.connectors[assistant.connector];
    if (!connector) throw new Error(`There's no "${assistant.connector}" connector set up for "${assistant.id}".`);
    if (this.guard && !cleared) {
      const verdict = await this.guard.check({ run, step, assistant });
      this.store.log(run.id, step.id, "guarded", { by: this.guard.name, assistant: assistant.id, ...verdict });
      if (verdict.action === "block") throw new Error(`${this.guard.name} stopped the hand-off to "${assistant.id}": ${verdict.reason}.`);
      if (verdict.action === "hold") {
        // Filed with the guard's own approver (ArmorIQ): approved there, and Huddle carries on by itself.
        const heldBy = verdict.heldBy && this.guard.awaitRelease ? verdict.heldBy : null;
        const message = heldBy
          ? `${this.guard.name} held the hand-off to "${assistant.id}" (${verdict.reason}). Approve it in ${heldBy.by}; the run carries on by itself once you do.`
          : `${this.guard.name} held the hand-off to "${assistant.id}" (${verdict.reason}). Let it go ahead?`;
        const approval = this.store.addApproval(run.id, step.id, message, heldBy);
        this.store.log(run.id, step.id, "waiting", { approval: approval.id, message, ...(heldBy ? { heldBy } : {}) });
        if (heldBy) this.watch(approval);
        return null;
      }
    }
    // Over budget, paid assistants wait; free ones and those without a price carry on.
    const price = priceOf(assistant);
    if (this.budget && price && (price.input > 0 || price.output > 0 || price.call > 0)) {
      const spent = this.spent();
      if (spent >= this.budget.usd) throw new OverBudget(`${capital(budgetName(this.budget.period))} budget is spent (${dollars(spent)} of ${dollars(this.budget.usd)}), so "${assistant.id}", which costs money, wasn't asked. Raise HUDDLE_BUDGET, or wait for the next ${this.budget.period}.`);
    }
    return { step, assistant, connector };
  }

  /** Makes a hand-off: the ask filled in and sent with what this assistant may see, its answer logged and counted. */
  private async handOff(run: Run, ready: Ready, context: RunContext): Promise<Answer> {
    const { step, assistant, connector } = ready;
    const handOff = { run, step, assistant };
    const ask = render(step.ask, context);
    // Kept notes from this assistant's slices only: all that fit the budget, the ones about this ask first.
    const memory = await this.memory.recall(ask, assistant.memory);
    // The run's images go only to an assistant allowed to see them.
    const images = assistant.images ? (context.images ?? []) : [];
    this.store.log(run.id, step.id, "asked", { assistant: assistant.id, ask, memory: memory.map((note) => note.id), ...(images.length ? { images: images.length } : {}) });
    const started = performance.now();
    let reply: Reply;
    try {
      reply = await connector.send({ assistant, ask, memory, runId: run.id, ...(images.length ? { images } : {}) });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      void this.guard?.report(handOff, { ok: false, chars: 0, error: why, ms: Math.round(performance.now() - started) });
      if (!step.optional) throw error;
      // An assistant the run can do without: noted, and the steps after it hear that it couldn't help.
      this.store.log(run.id, step.id, "skipped", { assistant: assistant.id, error: why });
      return { text: `${assistant.name ?? assistant.id} couldn't help this time (${why}).`, data: { skipped: true } };
    }
    const { usage, ...answer } = reply;
    const cost = spendOf(assistant, usage, memory.length ? `${memoryText(memory)}\n${ask}` : ask, answer.text);
    const counted = usage ? { model: assistant.model ?? assistant.connector, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: usage.cachedTokens ?? 0 } : undefined;
    void this.guard?.report(handOff, { ok: true, chars: reply.text.length, ms: Math.round(performance.now() - started), ...(counted ? { usage: counted } : {}) });
    this.store.addSpend(run, step.id, assistant.id, cost);
    this.store.log(run.id, step.id, "answered", { ...answer, cost });
    return { text: answer.text, data: answer.data };
  }

  /**
   * A pay step. First the shop prices the cart, and the payment is written for your board to show and sign; the
   * run waits. Once your board has signed, the shop is sent the signed payment, and its order is the step's answer.
   * A step whose payment failed asks your board again when the run is tried again; one still with PayPal is sent
   * to the shop again, which never charges a payment twice.
   */
  private async pay(run: Run, step: Extract<Step, { type: "pay" }>, context: RunContext): Promise<{ wait: true } | { wait: false; context: RunContext; next: string }> {
    const assistant = run.flow.assistants.find((candidate) => candidate.id === step.shop);
    if (!assistant?.url || assistant.connector !== "shop") throw new Error(`Step "${step.id}" buys at "${step.shop}", which isn't one of the flow's shops.`);
    const shop = this.shops(assistant.url);
    const next = step.next ?? following(run.flow, step);
    const earlier = this.store.signRequestFor(run.id, step.id);
    if (earlier?.status === "signed") return { wait: false, context: await this.checkout(run, step.id, shop, earlier, context), next };
    // Paid, then cut off before the run moved on (Huddle stopped): what was paid is the answer, not a second payment.
    if (earlier?.status === "paid" && !(step.id in context.steps)) return { wait: false, context: paidContext(context, step.id, earlier), next };

    let lines;
    try {
      lines = cartLines(render(step.cart, context));
    } catch (error) {
      throw new Error(`Step "${step.id}" can't buy anything: ${error instanceof Error ? error.message : String(error)}.`);
    }
    const cart = await shop.price(lines);
    const until = Math.min(Date.parse(cart.expires), this.now() + PAY_MINUTES * 60_000);
    if (!(until > this.now() + 60_000)) throw new Error(`${cart.shop.name}'s prices for that cart don't hold long enough to be signed; try again.`);
    const payment: Payment = {
      v: 1,
      kind: "buy",
      id: signableId("pay"),
      shop: cart.shop,
      cart: cart.id,
      items: cart.items.map((line) => ({ name: line.name, qty: line.qty, price: line.price })),
      total: cart.total,
      currency: cart.currency,
      expires: signableTime(until),
    };
    const text = signableText(payment);
    try {
      parseSignable(text);
    } catch (error) {
      throw new Error(`${cart.shop.name}'s cart can't be signed: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.store.addSignRequest({ id: payment.id, kind: "buy", text, runId: run.id, stepId: step.id, shop: shop.url, expires: payment.expires });
    const message = signableLine(payment);
    const approval = this.store.addApproval(run.id, step.id, message, null, null, payment.id);
    this.store.log(run.id, step.id, "waiting", { approval: approval.id, message, sign: payment.id, shop: payment.shop, cart: cart.id, total: payment.total, currency: payment.currency, lines: payment.items.length, expires: payment.expires });
    return { wait: true };
  }

  /** Sends the shop a payment your board signed, and keeps what the shop answers. */
  private async checkout(run: Run, stepId: string, shop: ShopClient, request: SignRequest, context: RunContext): Promise<RunContext> {
    let order: ShopOrder;
    try {
      order = await shop.checkout({ text: request.text, signature: request.signature!, key: request.key! });
    } catch (error) {
      // The shop said no (not linked, the cart changed, PayPal declined): asked again only with a new signature.
      // The shop couldn't be reached: the same signed payment goes again when the run is tried again.
      if (error instanceof ShopError) this.store.moveSignRequest(request.id, "signed", { status: "failed", error: error.message });
      throw error;
    }
    if (order.status === "charging") throw new Error("The shop is still waiting to hear from PayPal. Try the run again in a moment: the same payment is never charged twice.");
    if (order.status !== "paid" && order.status !== "pending") {
      this.store.moveSignRequest(request.id, "signed", { status: "failed", error: order.error ?? order.status });
      throw new Error(`PayPal didn't take the payment${order.error ? `: ${order.error}` : ` (the order is ${order.status})`}.`);
    }
    this.store.moveSignRequest(request.id, "signed", { status: "paid", result: order });
    this.store.log(run.id, stepId, "paid", { sign: request.id, order: order.id, status: order.status, paypal: order.paypal, total: order.total, currency: order.currency });
    return paidContext(context, stepId, { ...request, status: "paid", result: order });
  }

  /** Waits on every held approval still waiting (after a restart, say): they carry on when their approver decides. */
  resumeHolds(): number {
    const held = this.store.waitingApprovals().filter((approval) => approval.heldBy);
    for (const approval of held) this.watch(approval);
    return held.length;
  }

  private readonly watching = new Set<string>();

  /** Waits for a held approval's own approver; a no given here first wins. */
  private watch(approval: Approval): void {
    if (!approval.heldBy || !this.guard?.awaitRelease || this.watching.has(approval.id)) return;
    this.watching.add(approval.id);
    const heldBy = approval.heldBy;
    void this.guard
      .awaitRelease(heldBy)
      .then(async (outcome) => {
        if (this.store.approval(approval.id)?.status !== "waiting") return;
        this.store.log(approval.runId, approval.stepId, outcome === "approved" ? "released" : "refused", { by: heldBy.by, outcome });
        await this.decide(approval.id, outcome === "approved", { released: true });
      })
      .catch((error: unknown) => console.error(`[huddle] waiting on ${heldBy.by} for approval ${approval.id}:`, error))
      .finally(() => this.watching.delete(approval.id));
  }

  /**
   * What the web says about the facts in an approval's message, before the person is asked. A check that
   * can't run never stops the approval: the person is still asked, and the log says why it wasn't checked.
   */
  private async checkFacts(run: Run, stepId: string, message: string): Promise<FactCheck | null> {
    if (!this.checker) {
      this.store.log(run.id, stepId, "unchecked", { reason: "Checking facts needs TAVILY_API_KEY and a model (NEBIUS_API_KEY, or HUDDLE_LLM_URL and HUDDLE_LLM_MODEL)." });
      return null;
    }
    try {
      const checks = await this.checker(message);
      const count = (verdict: string) => checks.facts.filter((fact) => fact.verdict === verdict).length;
      this.store.log(run.id, stepId, "fact-checked", { facts: checks.facts.length, supported: count("supported"), contradicted: count("contradicted"), unclear: count("unclear"), by: checks.checkedBy, costUsd: checks.costUsd, claims: checks.facts.map((fact) => fact.claim), sentTo: checks.sentTo });
      if (checks.costUsd > 0) this.store.addSpend(run, stepId, "fact-check", { inputTokens: 0, outputTokens: 0, costUsd: checks.costUsd, estimated: false });
      return checks;
    } catch (error) {
      this.store.log(run.id, stepId, "unchecked", { reason: `Couldn't check the facts: ${error instanceof Error ? error.message : String(error)}` });
      return null;
    }
  }

  private fail(runId: string, stepId: string, context: RunContext, error: string): RunView {
    this.store.log(runId, stepId, "failed", { error });
    return this.end(runId, "failed", stepId, context, error);
  }

  /** A run is over: saved, the guard told, and what was said in it learned from when that was asked for. */
  private end(runId: string, state: "done" | "failed" | "declined", at: string | null, context: RunContext, error: string | null): RunView {
    this.store.saveRun({ id: runId, state, at, context, error });
    void this.guard?.finish(runId, state);
    const said = this.toLearn.get(runId);
    if (said !== undefined) {
      this.toLearn.delete(runId);
      void this.learn(runId, said);
    }
    return this.view(runId);
  }

  /** Whether learning from what you say is on (Memory's setting; off until you turn it on). */
  learning(): boolean {
    return this.learner !== null && this.store.setting(LEARNING) === "on";
  }

  /**
   * Learns from what the person said in a run they started themselves, once it ends. Call it only with the
   * person's own words: never mail, a webhook's body, or what another person or an assistant sent.
   */
  learnFrom(runId: string, said: string): void {
    if (!this.learning() || said.trim().length < 12) return;
    const run = this.store.run(runId);
    if (!run || run.flow.learn === false) return;
    if (run.state === "running" || run.state === "waiting") this.toLearn.set(runId, said);
    else void this.learn(runId, said);
  }

  private async learn(runId: string, said: string): Promise<void> {
    const learner = this.learner;
    const run = this.store.run(runId);
    if (!learner || !run) return;
    const text = said.trim().slice(0, 4_000);
    const slices = [...new Set([...this.store.notes().map((note) => note.slice), ...run.flow.assistants.flatMap((assistant) => assistant.memory)])];
    const sent = { by: learner.by, to: learner.to, host: learner.host, chars: text.length };
    try {
      const learned = await learner.learn(text, slices);
      const source = `learned from what you said in run ${runId}`;
      const known = this.store.notes();
      const added: Note[] = [];
      for (const { slice, note } of learned.notes) {
        if (alreadySays(note, known.filter((other) => other.slice === slice).map((other) => other.note))) continue;
        const suggested = this.store.suggest(slice, note, source);
        if (suggested.source === source && !added.some((other) => other.id === suggested.id)) added.push(suggested);
      }
      this.store.log(runId, "learn", "learned", { ...sent, notes: added.map((note) => ({ id: note.id, slice: note.slice, text: note.note })), costUsd: learned.costUsd });
      if (learned.costUsd > 0) this.store.addSpend(run, "learn", "memory: learning", { inputTokens: 0, outputTokens: 0, costUsd: learned.costUsd, estimated: false });
    } catch (error) {
      this.store.log(runId, "learn", "learned", { ...sent, notes: [], error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** A hand-off that may go ahead. */
interface Ready {
  readonly step: AgentStep;
  readonly assistant: Assistant;
  readonly connector: Connector;
}

/** What came back from a hand-off. */
interface Answer {
  readonly text: string;
  readonly data?: unknown;
}

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** A paid payment as its step's answer: what was paid, to whom, and the shop's order with PayPal's ids. */
function paidContext(context: RunContext, stepId: string, request: SignRequest): RunContext {
  const payment = parseSignable(request.text) as Payment;
  const order = request.result as ShopOrder;
  const amount = amountText(payment.total, payment.currency);
  const text =
    order.status === "pending"
      ? `PayPal is reviewing the ${amount} payment to ${payment.shop.name} (order ${order.paypal.orderId ?? order.id}); it isn't taken yet.`
      : `Paid ${amount} to ${payment.shop.name} with PayPal (order ${order.paypal.orderId ?? order.id}).`;
  const data = { paid: true, status: order.status, shop: payment.shop, total: payment.total, currency: payment.currency, items: payment.items, payment: payment.id, order: order.id, paypal: order.paypal };
  return { ...context, steps: { ...context.steps, [stepId]: { text, data } } };
}

/** The step after this one in the file, or "end". */
function following(flow: Flow, step: Step): string {
  const index = flow.steps.findIndex((candidate) => candidate.id === step.id);
  return flow.steps[index + 1]?.id ?? "end";
}
