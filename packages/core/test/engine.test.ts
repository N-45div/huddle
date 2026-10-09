import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { Connector, ConnectorRequest } from "../src/connector.ts";
import { mock } from "../src/connectors/mock.ts";
import { Engine, MAX_STEPS } from "../src/engine.ts";
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

  it("takes what a flow learns as a suggestion, never as kept memory", async () => {
    const store = new Store();
    const engine = new Engine(store, { mock });
    await engine.decide((await engine.start(invoiceFlow, "x")).waiting!.id, true);
    assert.deepEqual(store.notes().map((note) => [note.slice, note.status]), [["money", "suggested"]]);
  });
});
