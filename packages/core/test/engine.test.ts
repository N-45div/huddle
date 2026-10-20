import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { type Connector, type ConnectorRequest, memoryText } from "../src/connector.ts";
import { mock } from "../src/connectors/mock.ts";
import { Engine, MAX_STEPS } from "../src/engine.ts";
import { Memory } from "../src/memory/memory.ts";
import { parseFlow } from "../src/schema.ts";
import { Store } from "../src/store.ts";

const dir = mkdtempSync(join(tmpdir(), "huddle-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const invoiceFlow = parseFlow({
  name: "Invoices",
  assistants: [
    { id: "finance", connector: "mock", memory: ["money"], replies: { "*": '{"vendor": "Northwind", "amount": 450}' } },
    { id: "calendar", connector: "mock", replies: { "*": "Reminder added." } },
  ],
  steps: [
    { id: "read", type: "agent", agent: "finance", ask: "Read: {{input}}" },
    { id: "big", type: "condition", if: "{{read.data.amount}} > 200", then: "ask-me", else: "remind" },
    { id: "ask-me", type: "approval", message: "Pay {{read.data.vendor}} {{read.data.amount}}?", next: "remind", onNo: "learn" },
    { id: "remind", type: "agent", agent: "calendar", ask: "Remind me to pay {{read.data.vendor}}." },
    { id: "learn", type: "memory", slice: "money", note: "{{read.data.vendor}} invoices us." },
  ],
});

describe("a run", () => {
  it("goes step by step and stops at an approval, with the message filled in", async () => {
    const engine = new Engine(new Store(), { mock });
    const view = await engine.start(invoiceFlow, "invoice text");
    assert.equal(view.state, "waiting");
    assert.equal(view.at, "ask-me");
    assert.equal(view.waiting?.message, "Pay Northwind 450?");
    assert.deepEqual(view.context.steps.read?.data, { vendor: "Northwind", amount: 450 });
    assert.equal(view.context.steps.big?.text, "true");
  });

  it("survives a restart while waiting: a fresh process answers it and it carries on to the end", async () => {
    const path = join(dir, "restart.db");
    const first = new Store(path);
    const waiting = await new Engine(first, { mock }).start(invoiceFlow, "invoice text");
    first.close();

    const second = new Store(path);
    const done = await new Engine(second, { mock }).decide(waiting.waiting!.id, true);
    assert.equal(done.state, "done");
    assert.equal(done.context.steps.remind?.text, "Reminder added.");
    assert.deepEqual(second.logOf(done.id).map((line) => `${line.stepId}:${line.kind}`), [
      "read:asked", "read:answered", "big:checked", "ask-me:waiting", "ask-me:approved", "remind:asked", "remind:answered", "learn:suggested",
    ]);
    second.close();
  });

  it("follows onNo when you say no, and ends as declined when there's nowhere to go", async () => {
    const store = new Store();
    const engine = new Engine(store, { mock });
    const routed = await engine.decide((await engine.start(invoiceFlow, "x")).waiting!.id, false);
    assert.equal(routed.state, "done");
    assert.equal(routed.context.steps.remind, undefined, "a no skipped the reminder");
    assert.equal(routed.context.steps.learn?.text, "Northwind invoices us.");

    const plain = parseFlow({ ...invoiceFlow, steps: invoiceFlow.steps.map((step) => (step.type === "approval" ? { ...step, onNo: undefined } : step)) });
    const declined = await engine.decide((await engine.start(plain, "x")).waiting!.id, false);
    assert.equal(declined.state, "declined");
  });

  it("can't answer an approval twice", async () => {
    const engine = new Engine(new Store(), { mock });
    const id = (await engine.start(invoiceFlow, "x")).waiting!.id;
    await engine.decide(id, true);
    await assert.rejects(engine.decide(id, true), /already answered/);
  });

  it("shows the run as running again the moment an approval is answered, not once the next assistant is done", async () => {
    const store = new Store();
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: Connector = {
      async send(request) {
        if (request.assistant.id === "calendar") await gate;
        return mock.send(request);
      },
    };
    const engine = new Engine(store, { mock: slow });
    const runId = engine.answer((await engine.start(invoiceFlow, "x")).waiting!.id, true);
    assert.deepEqual([store.run(runId)?.state, store.run(runId)?.at], ["running", "remind"]);
    release();
    for (let tries = 0; store.run(runId)?.state === "running" && tries < 200; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(store.run(runId)?.state, "done");
  });

  it("fails with the reason when an assistant does, and stops a looping flow", async () => {
    const broken: Connector = { send: async () => { throw new Error("assistant offline"); } };
    const failed = await new Engine(new Store(), { mock: broken }).start(invoiceFlow, "x");
    assert.equal(failed.state, "failed");
    assert.equal(failed.at, "read");
    assert.equal(failed.error, "assistant offline");

    const loop = parseFlow({
      name: "loop",
      steps: [
        { id: "a", type: "condition", if: "1 == 1", then: "b", else: "end" },
        { id: "b", type: "condition", if: "1 == 1", then: "a", else: "end" },
      ],
    });
    const stopped = await new Engine(new Store(), { mock }).start(loop, "");
    assert.equal(stopped.state, "failed");
    assert.match(stopped.error ?? "", new RegExp(`after ${MAX_STEPS} steps`));
  });
});

describe("shared memory", () => {
  it("reaches an assistant only from the slices it may read, and only once a person kept it", async () => {
    const store = new Store();
    const seen: ConnectorRequest[] = [];
    const spy: Connector = { send: async (request) => { seen.push(request); return { text: "ok" }; } };
    store.remember("money", "Rent is due on the 5th.");
    store.remember("health", "Allergic to penicillin.");
    const guess = store.suggest("money", "Probably pays by card.", "an assistant");

    const flow = parseFlow({
      name: "m",
      assistants: [{ id: "finance", connector: "mock", memory: ["money"] }],
      steps: [{ id: "one", type: "agent", agent: "finance", ask: "hi" }],
    });
    const engine = new Engine(store, { mock: spy });
    await engine.start(flow, "");
    assert.deepEqual(seen[0]?.memory.map((note) => note.note), ["Rent is due on the 5th."], "no health notes, and no unkept guesses");

    assert.equal(store.keep(guess.id), true);
    await engine.start(flow, "");
    assert.deepEqual(seen[1]?.memory.map((note) => note.note), ["Rent is due on the 5th.", "Probably pays by card."]);
  });

  it("sends what recall picks for the ask once the slices hold more than the budget, never from another slice", async () => {
    const store = new Store();
    store.remember("home", "Miso the cat is fed at 7.");
    for (let index = 0; index < 30; index += 1) store.remember("home", `Note ${index}: the garden needs water.`);
    store.remember("health", "Miso the cat is allergic to fish, and is fed at 7.");
    const seen: ConnectorRequest[] = [];
    const spy: Connector = { send: async (request) => { seen.push(request); return { text: "ok" }; } };
    const flow = parseFlow({
      name: "pets",
      assistants: [{ id: "home", connector: "mock", memory: ["home"] }],
      steps: [{ id: "ask", type: "agent", agent: "home", ask: "When is {{input}} fed?" }],
    });
    const run = await new Engine(store, { mock: spy }, { memory: new Memory(store, { budget: 250 }) }).start(flow, "Miso");
    const memory = seen[0]?.memory ?? [];
    assert.ok(memory.some((note) => note.note === "Miso the cat is fed at 7."), "the note about the ask, though it's the oldest");
    assert.ok(memory.length < 31 && memoryText(memory).replaceAll("\n", "").length <= 250);
    assert.deepEqual(memory.filter((note) => note.slice !== "home"), []);
    const asked = store.logOf(run.id).find((line) => line.kind === "asked");
    assert.deepEqual((asked?.detail as { memory: string[] }).memory, memory.map((note) => note.id));
  });

  it("takes what a flow learns as a suggestion, never as kept memory", async () => {
    const store = new Store();
    const engine = new Engine(store, { mock });
    await engine.decide((await engine.start(invoiceFlow, "x")).waiting!.id, true);
    assert.deepEqual(store.notes().map((note) => [note.slice, note.status]), [["money", "suggested"]]);
  });

  it("tries a failed step again when asked, keeping the failed try in the log, and only for a failed run", async () => {
    let calls = 0;
    const flaky: Connector = {
      async send() {
        calls += 1;
        if (calls === 1) throw new Error("The tests timed out.");
        return { text: "All 14 pass." };
      },
    };
    const flow = parseFlow({ name: "Checkout", assistants: [{ id: "tester", connector: "http", url: "http://tester.test" }], steps: [{ id: "test", type: "agent", agent: "tester", ask: "Run the checkout tests" }] });
    const store = new Store();
    const engine = new Engine(store, { http: flaky });
    const failed = await engine.start(flow, "");
    assert.equal(failed.state, "failed");
    assert.throws(() => engine.retry("run_missing"), /no run/);
    assert.equal(engine.retry(failed.id), failed.id);
    for (let wait = 0; wait < 50 && store.run(failed.id)?.state !== "done"; wait++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(store.run(failed.id)?.state, "done");
    assert.deepEqual(store.logOf(failed.id).map((line) => line.kind), ["asked", "failed", "retried", "asked", "answered"]);
    assert.throws(() => engine.retry(failed.id), /Only a run that failed/);
  });
});
