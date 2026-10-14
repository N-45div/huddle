import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { Engine, mock, monid, Store } from "@huddle/core";
import { createApp } from "../src/app.ts";
import { monidCatalog } from "../src/monid.ts";

const OWNER = "a2a-token-0123456789";
const KEY = "mk_test_secret_key";

const JOBS = {
  description: "Search Google Jobs and get job postings with employer and location.",
  tags: ["jobs"],
  price: { type: "PER_CALL", amount: { value: 0.0012 } },
  input: { body: { type: "object", properties: { keyword: { type: "string", description: "Search query." }, location_name: { type: "string", description: "Where." } }, required: ["keyword"] } },
};
const SCRAPER = { description: "Scrape LinkedIn job listings.", tags: ["linkedin"], price: { type: "PER_RESULT", amount: { value: 0.001 } }, input: {} };

/** A stand-in Monid: two tools in its catalog, and every run finishing at once. */
function fakeMonid() {
  const runs: unknown[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path === "/v1/discover") {
      return Response.json({ results: [{ provider: "dataforseo", endpoint: "/serp/google-jobs", ...JOBS, score: 0.9 }, { provider: "acme", endpoint: "/linkedin-jobs", ...SCRAPER, score: 0.7 }] });
    }
    if (path === "/v1/inspect") {
      const catalog: Readonly<Record<string, unknown>> = { "dataforseo/serp/google-jobs": JOBS, "acme/linkedin-jobs": SCRAPER };
      const tool = catalog[`${body.provider}${body.endpoint}`];
      return tool ? Response.json(tool) : Response.json({ error: "not found" }, { status: 404 });
    }
    if (path === "/v1/run") {
      runs.push(body);
      return Response.json({ runId: "run_m1", status: "COMPLETED", output: { items: [{ title: "Staff nurse", company: "Apollo" }] }, providerResponse: { httpStatus: 200 }, billing: { reportedCost: { value: 2400, unit: "MICRO_DOLLAR" } } });
    }
    return Response.json({ error: "no such path" }, { status: 404 });
  }) as typeof fetch;
  return { fetcher, runs };
}

function setup(withMonid = true) {
  const { fetcher, runs } = fakeMonid();
  const store = new Store();
  const engine = new Engine(store, { mock, monid: monid(fetcher, { pollMs: 1 }) });
  const app = createApp({ store, engine, version: "test", publicUrl: "http://huddle.test", a2aToken: OWNER, ...(withMonid ? { monid: monidCatalog({ key: KEY, maxUsd: 0.1, fetcher }) } : {}) });
  return { store, app, runs };
}

type App = ReturnType<typeof setup>["app"];

async function rpc(app: App, method: string, params: object = {}, token: string | null = OWNER) {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "mcp-protocol-version": "2025-11-25", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await response.json()) as { result?: { tools?: { name: string; description: string }[]; content?: { text: string }[]; isError?: boolean }; error?: { message: string } };
}

const call = (app: App, name: string, args: object) => rpc(app, "tools/call", { name, arguments: args });

describe("Monid tools over MCP", () => {
  beforeEach(() => {
    process.env.MONID_API_KEY = KEY;
  });

  it("are the owner's, and only when Monid is set up", async () => {
    const names = async (app: App, token: string | null = OWNER) => (await rpc(app, "tools/list", {}, token)).result?.tools?.map((tool) => tool.name) ?? [];
    assert.deepEqual((await names(setup().app)).filter((name) => name.startsWith("monid_")), ["monid_find", "monid_show", "monid_run"]);
    assert.deepEqual((await names(setup(false).app)).filter((name) => name.startsWith("monid_")), []);
    const listed = (await rpc(setup().app, "tools/list")).result?.tools?.find((tool) => tool.name === "monid_run");
    assert.match(listed?.description ?? "", /up to \$0\.1 a run/);
  });

  it("find lists tools with their prices, and says which Huddle won't run", async () => {
    const answer = await call(setup().app, "monid_find", { need: "job listings in India" });
    const said = answer.result?.content?.[0]?.text ?? "";
    assert.match(said, /- dataforseo\/serp\/google-jobs \(\$0\.0012 a run\): Search Google Jobs/);
    assert.match(said, /- acme\/linkedin-jobs .*Huddle won't run it: it scrapes a site whose terms forbid scraping\./);
  });

  it("show gives the fields and an input to start from", async () => {
    const said = (await call(setup().app, "monid_show", { tool: "dataforseo/serp/google-jobs" })).result?.content?.[0]?.text ?? "";
    assert.match(said, /- body\.keyword \(required, string\): Search query\./);
    assert.match(said, /\{"body":\{"keyword":"\{\{ask\}\}"\}\}/);
    const missing = await call(setup().app, "monid_show", { tool: "dataforseo/nothing" });
    assert.equal(missing.result?.isError, true);
  });

  it("run goes through the engine: a run in Runs, with what Monid charged in its spend", async () => {
    const { app, store, runs } = setup();
    const answer = await call(app, "monid_run", { tool: "dataforseo/serp/google-jobs", input: { body: { keyword: "staff nurse", location_name: "India" } } });
    const said = answer.result?.content?.[0]?.text ?? "";
    assert.equal(answer.result?.isError, undefined);
    assert.match(said, /Staff nurse/);
    assert.match(said, /\(Huddle run run_\w+, Monid charged \$0\.0024\.\)/);
    assert.deepEqual(runs, [{ provider: "dataforseo", endpoint: "/serp/google-jobs", input: { body: { keyword: "staff nurse", location_name: "India" } } }]);
    const run = store.runs()[0];
    assert.equal(run?.flow.name, "Monid: dataforseo/serp/google-jobs");
    assert.equal(run?.state, "done");
    assert.equal(store.spendSince("2000-01-01").find((row) => row.assistant === "monid")?.usd, 0.0024);
  });

  it("run refuses a blocked tool, and bad arguments, without spending anything", async () => {
    const { app, runs } = setup();
    const blocked = await call(app, "monid_run", { tool: "acme/linkedin-jobs", input: { body: {} } });
    assert.equal(blocked.result?.isError, true);
    assert.match(blocked.result?.content?.[0]?.text ?? "", /won't run acme\/linkedin-jobs/);
    const bare = await call(app, "monid_run", { tool: "dataforseo/serp/google-jobs", input: "nurse" });
    assert.equal(bare.result?.isError, true);
    assert.equal(runs.length, 0);
  });

  it("aren't there for anyone but the owner", async () => {
    const { app } = setup();
    const stranger = await rpc(app, "tools/call", { name: "monid_find", arguments: { need: "jobs" } }, null);
    assert.equal(stranger.result, undefined);
  });
});

describe("the canvas's Monid search", () => {
  it("finds tools and shows one's details, and says when Monid isn't set up", async () => {
    const { app } = setup();
    const found = (await (await app.request("/api/monid/find?q=job+listings")).json()) as { tool: string; price: string; blocked: string | null }[];
    assert.deepEqual(
      found.map((tool) => [tool.tool, tool.price, tool.blocked !== null]),
      [
        ["dataforseo/serp/google-jobs", "$0.0012 a run", false],
        ["acme/linkedin-jobs", "$0.001 a result", true],
      ],
    );
    const details = (await (await app.request("/api/monid/show?tool=dataforseo/serp/google-jobs")).json()) as { starter: unknown; fields: unknown[] };
    assert.deepEqual(details.starter, { body: { keyword: "{{ask}}" } });
    assert.equal(details.fields.length, 2);
    assert.equal((await app.request("/api/monid/show?tool=dataforseo/nothing")).status, 404);
    assert.equal((await app.request("/api/monid/find?q=x")).status, 400);
    const off = await setup(false).app.request("/api/monid/find?q=jobs");
    assert.equal(off.status, 501);
    assert.match(((await off.json()) as { error: string }).error, /Set MONID_API_KEY/);
  });
});
