import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Connector } from "../src/connector.ts";
import { mock } from "../src/connectors/mock.ts";
import { Engine } from "../src/engine.ts";
import { armoriq, armoriqPlan, type ArmorIQSdk, registerWithArmorIQ } from "../src/guards/armoriq.ts";
import { parseFlow } from "../src/schema.ts";
import { Store } from "../src/store.ts";

const flow = parseFlow({
  name: "Plan and remind",
  assistants: [
    { id: "planner", connector: "mock", replies: { "*": "Plan done." } },
    { id: "mailer", connector: "email", to: ["me@example.com"], from: "Huddle <huddle@example.com>" },
  ],
  steps: [
    { id: "plan", type: "agent", agent: "planner", ask: "Plan: {{input}}" },
    { id: "send", type: "agent", agent: "mailer", ask: "{{plan.text}}" },
  ],
});

const email: Connector = { send: async () => ({ text: "Sent." }) };

/** A stand-in for @armoriq/sdk: decides by tool name and records every call. */
function fakeSdk(decide: (tool: string) => { allowed: boolean; action: string; reason?: string; matchedPolicy?: string }, fail?: { plan?: Error; check?: Error }) {
  const calls: string[] = [];
  const sdk: ArmorIQSdk = {
    ArmorIQClient: class {
      constructor(options: { apiKey: string; userId: string; agentId: string }) {
        calls.push(`client ${options.agentId}/${options.userId}`);
      }
      async recordTokenUsage(payload: { product: string; sessionId: string; entries: { model: string; inputTokens: number; outputTokens: number }[] }) {
        calls.push(`tokens ${payload.product} ${payload.sessionId} ${payload.entries.map((entry) => `${entry.model}:${entry.inputTokens}/${entry.outputTokens}`).join(",")}`);
        return { ok: true };
      }
    },
    ArmorIQSession: class {
      async startPlan(tools: { name: string; args: Record<string, unknown> }[], goal?: string) {
        calls.push(`plan ${tools.map((tool) => tool.name).join(",")} "${goal}"`);
        if (fail?.plan) throw fail.plan;
        return { planId: "plan-1" };
      }
      async awaitApproval(id: string, options?: { userEmail?: string }) {
        calls.push(`await ${id} as ${options?.userEmail}`);
        return "approved";
      }
      async check(tool: string, args: Record<string, unknown>, userEmail?: string) {
        calls.push(`check ${tool} ${JSON.stringify(args)}${userEmail && userEmail !== "huddle-agent@huddle.local" ? ` as ${userEmail}` : ""}`);
        if (fail?.check) throw fail.check;
        return decide(tool);
      }
      async report(tool: string, _args: Record<string, unknown>, result: unknown, options?: { status?: string }) {
        calls.push(`report ${tool} ${JSON.stringify(result)} ${options?.status}`);
      }
      async close(status?: string) {
        calls.push(`close ${status}`);
      }
    } as unknown as ArmorIQSdk["ArmorIQSession"],
  };
  return { sdk, calls };
}

describe("the ArmorIQ guard", () => {
  it("plans a flow's hand-offs as huddle__<connector>, with the step and assistant as arguments", () => {
    assert.deepEqual(armoriqPlan(flow), [
      { name: "huddle__mock", args: { step: "plan", assistant: "planner" } },
      { name: "huddle__email", args: { step: "send", assistant: "mailer" } },
    ]);
  });

  it("signs one plan per run, checks each hand-off against it, and reports sizes, never the answer", async () => {
    const { sdk, calls } = fakeSdk(() => ({ allowed: true, action: "allow", reason: "allow_with_logging", matchedPolicy: "cli-huddle-huddle" }));
    const store = new Store();
    const view = await new Engine(store, { mock, email }, { guard: armoriq({ apiKey: "ak_test_x", sdk: async () => sdk }) }).start(flow, "secret plans");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(view.state, "done");
    assert.deepEqual(calls, [
      "client huddle/huddle-owner",
      'plan huddle__mock,huddle__email "Run the "Plan and remind" flow"',
      'check huddle__mock {"step":"plan","assistant":"planner"}',
      'report huddle__mock {"ok":true,"chars":10} success',
      'check huddle__email {"step":"send","assistant":"mailer"}',
      'report huddle__email {"ok":true,"chars":5} success',
      "close ok",
    ]);
    assert.ok(!calls.some((call) => call.includes("secret")));
    const guarded = store.logOf(view.id).find((line) => line.kind === "guarded");
    assert.deepEqual(guarded?.detail, { by: "ArmorIQ", assistant: "planner", action: "allow", reason: "allowed, and logged", code: "allow_with_logging", policy: "cli-huddle-huddle" });
  });

  it("says ArmorIQ's reasons plainly: not allowed, not in the plan, no policy yet", async () => {
    for (const [code, said] of [
      ["tool_not_in_allowlist", "your ArmorIQ policy doesn't allow huddle__email"],
      ["tool-not-in-plan: 'huddle__email' was not declared in the captured plan", "huddle__email wasn't in the plan ArmorIQ signed for this run"],
      ["no_matching_policy", "no ArmorIQ policy covers huddle__email yet (npm run huddle -- armoriq register)"],
    ] as const) {
      const { sdk } = fakeSdk((tool) => (tool === "huddle__email" ? { allowed: false, action: "block", reason: code } : { allowed: true, action: "allow" }));
      const view = await new Engine(new Store(), { mock, email }, { guard: armoriq({ apiKey: "ak_test_x", sdk: async () => sdk }) }).start(flow, "x");
      assert.equal(view.state, "failed");
      assert.equal(view.error, `ArmorIQ stopped the hand-off to "mailer": ${said}.`);
    }
  });

  it("fails closed when ArmorIQ can't be reached, and tries again on the next run", async () => {
    let down = true;
    const { sdk, calls } = fakeSdk(() => ({ allowed: true, action: "allow" }));
    const flaky = async () => {
      if (down) throw new Error("getaddrinfo ENOTFOUND api.armoriq.ai");
      return sdk;
    };
    const engine = new Engine(new Store(), { mock, email }, { guard: armoriq({ apiKey: "ak_test_x", sdk: flaky }) });
    const first = await engine.start(flow, "x");
    assert.equal(first.state, "failed");
    assert.match(first.error ?? "", /ArmorIQ couldn't check it, so it didn't go ahead: getaddrinfo ENOTFOUND/);
    down = false;
    const second = await engine.start(flow, "x");
    assert.equal(second.state, "done");
    assert.equal(calls.filter((call) => call.startsWith("client")).length, 1);
  });

  it("plans again once a run's plan has nearly run out (a run can wait on you for days)", async () => {
    let clock = 0;
    const { sdk, calls } = fakeSdk((tool) => (tool === "huddle__email" ? { allowed: false, action: "hold", reason: "needs a yes" } : { allowed: true, action: "allow" }));
    const engine = new Engine(new Store(), { mock, email }, { guard: armoriq({ apiKey: "ak_test_x", sdk: async () => sdk, now: () => clock }) });
    const flow3 = parseFlow({ ...flow, steps: [...flow.steps, { id: "again", type: "agent", agent: "planner", ask: "again" }] });
    const waiting = await engine.start(flow3, "x");
    assert.equal(waiting.state, "waiting");
    clock = 2 * 60 * 60_000;
    const done = await engine.decide(waiting.waiting!.id, true);
    assert.equal(done.state, "done");
    assert.equal(calls.filter((call) => call.startsWith("plan")).length, 2);
  });
});

describe("ArmorIQ's token counts", () => {
  it("get the tokens an assistant counted, filed under the run's plan, and never a guess", async () => {
    const { sdk, calls } = fakeSdk(() => ({ allowed: true, action: "allow" }));
    const counted: Connector = { send: async () => ({ text: "Sent.", usage: { inputTokens: 120, outputTokens: 30 } }) };
    await new Engine(new Store(), { mock, email: counted }, { guard: armoriq({ apiKey: "ak_test_x", sdk: async () => sdk }) }).start(flow, "x");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(calls.filter((call) => call.startsWith("tokens")), ["tokens huddle plan-1 email:120/30"], "the stand-in counted nothing, so nothing is sent for it");
  });
});

describe("an ArmorIQ hold", () => {
  it("is filed as Huddle's own agent address, links to the run's plan, and carries on once ArmorIQ approves it", async () => {
    const { sdk, calls } = fakeSdk((tool) => (tool === "huddle__email" ? { allowed: false, action: "hold", reason: "rule_action_hold", matchedPolicy: "cli-huddle-huddle", delegationId: "del-9" } : { allowed: true, action: "allow" }));
    const store = new Store();
    const guard = armoriq({ apiKey: "ak_test_x", sdk: async () => sdk, pollSeconds: 0 });
    const engine = new Engine(store, { mock, email }, { guard });
    const waiting = await engine.start(flow, "x");
    assert.equal(waiting.state, "waiting");
    assert.deepEqual(waiting.waiting?.heldBy, { by: "ArmorIQ", id: "del-9", url: "https://platform.armoriq.ai/dashboard/plans/plan-1" });
    assert.match(waiting.waiting?.message ?? "", /ArmorIQ held the hand-off to "mailer" \(your ArmorIQ policy wants a yes before huddle__email\)\. Approve it in ArmorIQ/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(engine.view(waiting.id).state, "done");
    assert.ok(calls.includes("await del-9 as huddle-agent@huddle.local"));
  });

  it("can come from another address", async () => {
    const { sdk, calls } = fakeSdk(() => ({ allowed: true, action: "allow" }));
    await new Engine(new Store(), { mock, email }, { guard: armoriq({ apiKey: "ak_test_x", sdk: async () => sdk, requester: "agent@example.com" }) }).start(flow, "x");
    assert.ok(calls.some((call) => call.endsWith(" as agent@example.com")));
  });
});

describe("registering with ArmorIQ", () => {
  it("sends the agent, the MCP and an allow list, with the key in the header and never in the body", async () => {
    let seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null;
    const fetcher = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
      return Response.json({ success: true, agent: { name: "huddle" }, policies: [{ name: "cli-huddle-huddle" }] });
    }) as typeof fetch;
    const result = await registerWithArmorIQ({ apiKey: "ak_test_secret", mcpUrl: "http://localhost:7700/mcp", allow: ["openclaw", "email"], fetcher });
    assert.deepEqual(result, { ok: true, agent: "huddle", policy: "cli-huddle-huddle", allowed: ["openclaw", "email"] });
    assert.equal(seen!.url, "https://api.armoriq.ai/iap/sdk/register");
    assert.equal(seen!.headers.authorization, "Bearer ak_test_secret");
    assert.ok(!JSON.stringify(seen!.body).includes("ak_test_secret"));
    assert.deepEqual(seen!.body.policy, { allow: ["huddle.openclaw", "huddle.email"], deny: [] });
    assert.equal(seen!.body.onConflict, undefined);
  });

  it("won't wipe dashboard changes unless told to replace them", async () => {
    const fetcher = (async () => Response.json({ code: "POLICY_REPLACE_CONFIRMATION_REQUIRED", message: "Saving would replace cli-huddle-huddle and remove 2 stored setting(s)." }, { status: 409 })) as unknown as typeof fetch;
    const result = await registerWithArmorIQ({ apiKey: "ak_test_x", mcpUrl: "http://localhost:7700/mcp", allow: ["mock"], fetcher });
    assert.deepEqual(result, { ok: false, conflict: true, error: "Saving would replace cli-huddle-huddle and remove 2 stored setting(s). (run it with --replace to overwrite those changes)" });
  });
});
