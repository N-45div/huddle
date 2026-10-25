import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Assistants, type Budget, DEFAULT_MAX_USD, defaultConnectors, dollars, embedder, Engine, factChecker, jevJudge, jevPresenter, type Judge, Memory, Meter, modelJudge, modelPresenter, NEMOTRON, OpenShell, openshell, OWN_CALLS_PER_MINUTE, PactIdentity, pact, parseBudget, RECALL_BUDGET, refreshTokenFactoryPrices, reranker, Router, TOKEN_FACTORY_URL, rulesPresenter, type Guard, guardFromEnv, nemoSpeech, noteTaker, SignIns, Store, storedGrants, tidyMemory, viewWriter } from "@huddle/core";
import { createApp } from "./app.ts";
import { describer } from "./describe.ts";
import { Asker, planner } from "./just-ask.ts";
import { deviceRoutes, guardUpgrades } from "./devices.ts";
import { monidCatalog } from "./monid.ts";
import { SandboxWatcher } from "./sandbox-requests.ts";
import { Scheduler } from "./scheduler.ts";
import { webApp } from "./static.ts";

/**
 * Starts Huddle: the canvas, the API, webhooks, schedules, and the A2A and MCP endpoints, from one
 * process and one SQLite file. Everything is set with environment variables:
 *
 *   HUDDLE_DB          where to keep everything (default huddle.db)
 *   HUDDLE_HOST        the address to listen on (default 127.0.0.1, this machine only)
 *   HUDDLE_PORT        default 7700
 *   HUDDLE_TOKEN       the token for the canvas and API; required unless listening on this machine only
 *   HUDDLE_PUBLIC_URL  how others reach this Huddle, for webhook and A2A addresses
 *   HUDDLE_A2A_TOKEN   a separate token for assistants calling Huddle over A2A or MCP (default HUDDLE_TOKEN)
 *   HUDDLE_LLM_URL, HUDDLE_LLM_MODEL, HUDDLE_LLM_KEY   an OpenAI-compatible model for "describe it", for
 *                      judging "auto", and for showing answers as views
 *   HUDDLE_SPEECH_URL  NVIDIA NeMo-Speech on this machine (nemo-speech serve): the Huddle button listens
 *                      with Nemotron 3.5 ASR and speaks with Magpie TTS; audio never leaves the machine
 *   HUDDLE_SPEECH_LANGUAGE  what the button listens for: auto (default), en-US, hi-IN, ...
 *   NEBIUS_API_KEY     NVIDIA Nemotron on Nebius Token Factory: the nebius connector's key, and, when no
 *                      HUDDLE_LLM_URL is set, Huddle's own model calls, each on the tier its job needs:
 *                      Lightning judges "auto" and picks views, Super fills them in, Ultra drafts flows
 *   HUDDLE_MEMORY_BUDGET  characters of kept notes each request may carry (default 4000)
 *   HUDDLE_EMBED_URL, HUDDLE_EMBED_MODEL, HUDDLE_EMBED_KEY   an OpenAI-compatible embeddings API, so
 *                      memory finds notes by meaning as well as by their words
 *   HUDDLE_RERANK_URL, HUDDLE_RERANK_MODEL, HUDDLE_RERANK_KEY   a rerank API (Voyage, Cohere, Jina) that
 *                      orders the notes memory finds
 *   HUDDLE_WEB         the built canvas to serve (default packages/web/dist)
 *   HUDDLE_ROUTER_KEY  a key just for the router's OpenAI-compatible /v1 (HUDDLE_TOKEN works there too)
 *   TYPESAFE_API_KEY   Jev judges model "auto" (HUDDLE_JEV_MODEL, default jev-latest); without it the
 *                      HUDDLE_LLM_* model judges; with neither, "auto" uses your list's order
 *   HUDDLE_PACT_ISSUER who Huddle says it is when it talks PACT to businesses (default HUDDLE_PUBLIC_URL);
 *                      its public key is at {issuer}/.well-known/jwks.json, so businesses must reach it
 *   HUDDLE_OPENSHELL_GATEWAY  an NVIDIA OpenShell gateway (e.g. https://127.0.0.1:8080), for sandboxed
 *                      assistants and their requests in the approvals inbox; OPENSHELL_TLS_DIR holds its
 *                      client certificate (default ~/.config/openshell/gateways/openshell/mtls)
 *   RESEND_API_KEY     sends email (the email connector's default key) and reads mail that arrives;
 *                      reading needs a full-access key
 *   RESEND_WEBHOOK_SECRET  the signing secret of Resend's inbound webhook, pointed at /hooks/email
 *   HUDDLE_OWNER_EMAILS    your addresses, comma-separated: mail from them counts as you
 *   TAVILY_API_KEY     web search (tavily.com): the tavily connector's key, and, with a model set up, the facts
 *                      in approvals that ask for it (check: true) checked on the web before you're asked
 *   CONTEXT_DEV_API_KEY    context.dev: the contextdev connector's key (reads pages, searches, looks companies up)
 *   MONID_API_KEY      Monid's paid data tools (monid.ai): the monid connector's key, the canvas's tool
 *                      search, and monid_find, monid_show, monid_run and monid_result for your MCP clients
 *   HUDDLE_MONID_MAX_USD  the most one of those MCP runs may cost, in US dollars (default 0.10)
 *   HUDDLE_BUDGET      a cap on what hand-offs to priced assistants may spend, in US dollars: "20/month"
 *                      or "5/day"; past 80% the router's "auto" goes for the cheapest that fits
 *   HUDDLE_GUARD       something to check every hand-off first, if you want one (none by default):
 *                      armoriq  ArmorIQ: the run's signed plan and your policy (ARMORIQ_API_KEY;
 *                               HUDDLE_ARMORIQ_AGENT, default huddle; a held hand-off is approved on
 *                               ArmorIQ's Plans page, its request from HUDDLE_ARMORIQ_REQUESTER).
 *                               Set the policy up once with: npm run huddle -- armoriq register
 *                      http     your own policy service: HUDDLE_GUARD_URL answers allow, block or hold
 *                               (HUDDLE_GUARD_KEY as a Bearer token; HUDDLE_GUARD_ON_FAILURE block|allow)
 *   HUDDLE_OWN_CALLS_PER_MINUTE  the most model calls Huddle makes for itself in a minute (default 30): drafting
 *                      flows, judging "auto", views, fact checks, learning, tidying. They count in spend and
 *                      stop once HUDDLE_BUDGET is spent, so a Huddle others can reach can't run up a bill
 */

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;
const host = env("HUDDLE_HOST") ?? "127.0.0.1";
const port = Number(env("HUDDLE_PORT") ?? 7700);
const token = env("HUDDLE_TOKEN");
const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
const budget = Number(env("HUDDLE_MEMORY_BUDGET") ?? RECALL_BUDGET);

if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`HUDDLE_PORT must be a port number, not "${env("HUDDLE_PORT")}".`);
if (!Number.isInteger(budget) || budget < 1) throw new Error(`HUDDLE_MEMORY_BUDGET must be a number of characters, not "${env("HUDDLE_MEMORY_BUDGET")}".`);
if (!loopback && !token) {
  console.error(`Huddle won't listen on ${host} without a token: anyone who reaches it could run your assistants.\nSet HUDDLE_TOKEN to a long random string (e.g. openssl rand -hex 32), or listen on 127.0.0.1.`);
  process.exit(1);
}
if (token && token.length < 16) {
  console.error("HUDDLE_TOKEN is too short; use at least 16 characters (e.g. openssl rand -hex 32).");
  process.exit(1);
}

const nebiusKey = env("NEBIUS_API_KEY");
// With just a Token Factory key, Huddle's own model calls run on NVIDIA Nemotron; HUDDLE_LLM_MODEL puts every one on a single model.
const onNemotron = !env("HUDDLE_LLM_URL") && Boolean(nebiusKey);
const llmUrl = env("HUDDLE_LLM_URL") ?? (onNemotron ? TOKEN_FACTORY_URL : undefined);
const llmKey = env("HUDDLE_LLM_KEY") ?? (onNemotron ? nebiusKey : undefined);
const llmModel = env("HUDDLE_LLM_MODEL");
const modelFor = (tier: keyof typeof NEMOTRON): string | undefined => llmModel ?? (onNemotron ? NEMOTRON[tier] : undefined);
const quickModel = modelFor("lightning");
const fillModel = modelFor("super");
const draftModel = modelFor("ultra");
// The desktop app runs Huddle bundled into one file, with its version given.
const version = env("HUDDLE_VERSION") ?? (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
// On Render, its own address (RENDER_EXTERNAL_URL) is how others reach this Huddle unless you say otherwise.
const publicUrl = (env("HUDDLE_PUBLIC_URL") ?? env("RENDER_EXTERNAL_URL") ?? `http://${loopback || host === "0.0.0.0" || host === "::" ? "localhost" : host}:${port}`).replace(/\/$/, "");

const store = new Store(env("HUDDLE_DB") ?? "huddle.db");
const interrupted = store.failInterrupted();
if (interrupted) console.log(`[huddle] ${interrupted} run(s) were cut off when Huddle last stopped; marked failed.`);
let shell: OpenShell | null;
try {
  shell = OpenShell.fromEnv();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const identity = PactIdentity.load(store, env("HUDDLE_PACT_ISSUER") ?? publicUrl);
const embedUrl = env("HUDDLE_EMBED_URL");
const embedModel = env("HUDDLE_EMBED_MODEL");
const rerankUrl = env("HUDDLE_RERANK_URL");
const rerankModel = env("HUDDLE_RERANK_MODEL");
const memory = new Memory(store, {
  budget,
  embedder: embedUrl && embedModel ? embedder({ url: embedUrl, model: embedModel, key: env("HUDDLE_EMBED_KEY") }) : null,
  reranker: rerankUrl && rerankModel ? reranker({ url: rerankUrl, model: rerankModel, key: env("HUDDLE_RERANK_KEY") }) : null,
});
// PACT sign-ins wait in Approvals while the step that needs them keeps running.
const signIns = new SignIns();
let guard: Guard | null;
try {
  guard = guardFromEnv(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
let spendCap: Budget | null;
try {
  spendCap = parseBudget(env("HUDDLE_BUDGET"));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const perMinute = Number(env("HUDDLE_OWN_CALLS_PER_MINUTE") ?? OWN_CALLS_PER_MINUTE);
if (!Number.isInteger(perMinute) || perMinute < 1) {
  console.error(`HUDDLE_OWN_CALLS_PER_MINUTE must be a whole number of calls, not "${env("HUDDLE_OWN_CALLS_PER_MINUTE")}".`);
  process.exit(1);
}
// Huddle's own model calls are counted in spend, stop with the budget, and are held to so many a minute.
const meter = new Meter(store, { budget: spendCap, perMinute });
// Approvals that ask (check: true) have their facts checked on the web first: the quick model lists them, Tavily searches, the other model weighs the sources.
const tavilyKey = env("TAVILY_API_KEY");
const checker = tavilyKey && llmUrl && quickModel && fillModel ? factChecker({ tavilyKey, lister: { url: llmUrl, model: quickModel, key: llmKey }, judge: { url: llmUrl, model: fillModel, key: llmKey }, fetcher: meter.fetchFor("fact check", { record: false }) }) : undefined;
// Learning from what you say (once you turn it on in Memory): the fill-in model reads your words after runs you
// start. Super, not Lightning: on 18 Oct Lightning kept the request itself ("Weekend trip with a companion") and
// misfiled notes; Super didn't, for about $0.00013 a message, after the run.
const learner = llmUrl && fillModel ? noteTaker({ model: { url: llmUrl, model: fillModel, key: llmKey }, fetcher: meter.fetchFor("learning", { record: false }) }) : undefined;
const engine = new Engine(store, { ...defaultConnectors(), openshell: openshell(() => shell), pact: pact(() => identity, undefined, { signIns, grants: storedGrants(store) }) }, { memory, guard: guard ?? undefined, budget: spendCap, checker, learner });
const sandboxes = shell ? new SandboxWatcher(shell, store) : undefined;
// Hand-offs ArmorIQ held before a restart: wait on them again, so they carry on once approved there.
const held = engine.resumeHolds();
if (held) console.log(`[huddle] waiting on ${held} hand-off(s) ArmorIQ holds for your approval there.`);
const scheduler = new Scheduler(store, engine);

const typesafeKey = env("TYPESAFE_API_KEY");
let judge: Judge | null = null;
if (typesafeKey) judge = jevJudge({ key: typesafeKey, model: env("HUDDLE_JEV_MODEL"), fetcher: meter.fetchFor("auto judge") });
else if (llmUrl && quickModel) judge = modelJudge({ url: llmUrl, model: quickModel, key: llmKey, fetcher: meter.fetchFor("auto judge") });

// How answers are shown: Jev chooses the view if it's set up, else the HUDDLE_LLM_* model, else plain rules; a model fills charts and the like in.
const viewsFetch = meter.fetchFor("views");
const presenter = typesafeKey ? jevPresenter({ key: typesafeKey, model: env("HUDDLE_JEV_MODEL"), fetcher: viewsFetch }) : llmUrl && quickModel ? modelPresenter({ url: llmUrl, model: quickModel, key: llmKey, fetcher: viewsFetch }) : rulesPresenter;
const writer = llmUrl && fillModel ? viewWriter({ url: llmUrl, model: fillModel, key: llmKey, fetcher: viewsFetch }) : null;
// Token Factory's prices, read fresh when it's in use (the built-in ones stand if the catalog can't be reached).
if (nebiusKey) refreshTokenFactoryPrices().catch(() => undefined);

// Monid's catalog: the canvas's tool search and the owner's MCP tools, within a cap per run.
const monidKey = env("MONID_API_KEY");
const monidCap = Number(env("HUDDLE_MONID_MAX_USD") ?? DEFAULT_MAX_USD);
const monidMaxUsd = Number.isFinite(monidCap) && monidCap >= 0 && monidCap <= 100 ? monidCap : DEFAULT_MAX_USD;

const router = new Router(store, engine, judge);
// "Just ask" (the button, the canvas, the API and MCP): the fill-in model reads what was said and picks a saved
// flow, one assistant, or a team; a team ends with Hud, on the quick model, saying what each came back with.
const hud = llmUrl && quickModel
  ? Assistants.parse([
      onNemotron
        ? { id: "hud", name: "Hud", connector: "nebius", model: quickModel, memory: [] }
        : { id: "hud", name: "Hud", connector: "openai", url: llmUrl, model: quickModel, ...(env("HUDDLE_LLM_KEY") ? { keyEnv: "HUDDLE_LLM_KEY" } : {}), memory: [] },
    ])[0]
  : undefined;
const justAsk = llmUrl && fillModel ? planner({ url: llmUrl, model: fillModel, key: llmKey, fetcher: meter.fetchFor("just ask"), ...(hud ? { wrapUp: hud } : {}) }) : undefined;
const asker = justAsk ? new Asker(store, engine, router, justAsk) : undefined;
const app = createApp({
  store,
  engine,
  version,
  publicUrl,
  token,
  a2aToken: env("HUDDLE_A2A_TOKEN"),
  describe: llmUrl && draftModel ? describer({ url: llmUrl, model: draftModel, key: llmKey, fetcher: meter.fetchFor("describe it") }) : undefined,
  sandboxes,
  signIns,
  pact: identity,
  router,
  routerKey: env("HUDDLE_ROUTER_KEY"),
  asker,
  present: { presenter, writer },
  email: { webhookSecret: env("RESEND_WEBHOOK_SECRET"), apiKey: env("RESEND_API_KEY"), ownerEmails: (env("HUDDLE_OWNER_EMAILS") ?? "").split(",").filter((address) => address.trim()) },
  monid: monidKey ? monidCatalog({ key: monidKey, maxUsd: monidMaxUsd }) : undefined,
  // Tidying memory up: the fill-in model reads each slice's kept notes, only when the person asks.
  tidy: llmUrl && fillModel ? (notes) => tidyMemory(notes, { model: { url: llmUrl, model: fillModel, key: llmKey }, fetcher: meter.fetchFor("tidy up") }) : undefined,
});
// Your gadgets (the Huddle button, the canvas's virtual one) over a WebSocket, before the canvas's catch-all.
const websockets = createNodeWebSocket({ app });
const speechUrl = env("HUDDLE_SPEECH_URL");
const speech = speechUrl ? nemoSpeech({ url: speechUrl, language: env("HUDDLE_SPEECH_LANGUAGE") ?? "auto" }) : undefined;
deviceRoutes(app, { store, engine, token, version, upgradeWebSocket: websockets.upgradeWebSocket, speech, router, ...(justAsk ? { planner: justAsk } : {}) });
const web = env("HUDDLE_WEB") ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
const built = existsSync(join(web, "index.html"));
app.use("*", webApp(web));
if (!built) app.get("/", (c) => c.text("Huddle is running, but the canvas isn't built yet: run npm run build, then restart.", 503));

const server = serve({ fetch: app.fetch, hostname: host, port }, () => {
  console.log(`  Devices (the Huddle button): ${publicUrl.replace(/^http/, "ws")}/devices/ws, with a device token from the canvas's Devices page`);
  console.log(`  Voice: ${speech ? `${speech.name} at ${speech.url}` : "off (run NVIDIA NeMo-Speech and set HUDDLE_SPEECH_URL to talk to the button)"}`);
  if (asker) console.log(`  Just ask (the button's first choice, the canvas's quick bar, POST /api/ask, MCP just_ask): ${fillModel} picks a saved flow, one assistant, or a team${hud ? `, and Hud (${quickModel}) sums a team up` : ""}`);
  scheduler.start();
  sandboxes?.start();
  console.log(`Huddle ${version} is on ${publicUrl}${token ? " (token required)" : ""}`);
  console.log(`  A2A Agent Card: ${publicUrl}/.well-known/agent-card.json`);
  console.log(`  MCP server (Claude, Cursor, any MCP client): ${publicUrl}/mcp`);
  console.log(`  Router (OpenAI-compatible): ${publicUrl}/v1, model = one of your assistants' ids, or "auto" (${judge ? `judged by ${judge.name}` : "no judge: your list's order"})`);
  if (spendCap) console.log(`  Budget: ${dollars(spendCap.usd)} a ${spendCap.period} for priced assistants and Huddle's own model calls; ${dollars(engine.spent())} spent so far`);
  if (llmUrl || typesafeKey) console.log(`  Spending guard: Huddle's own model calls count in spend, at most ${meter.perMinute} a minute${spendCap ? ", and none once the budget is spent" : " (set HUDDLE_BUDGET to cap them)"}`);
  if (!built) console.log(`  The canvas isn't built (no ${join(web, "index.html")}): run npm run build.`);
  if (onNemotron) console.log(`  Huddle's own model calls: NVIDIA Nemotron on Nebius Token Factory (${llmModel ?? "Lightning judges and picks views, Super fills them in, Ultra drafts flows"})`);
  if (!llmUrl || !draftModel) console.log('  "Describe it" is off: set NEBIUS_API_KEY, or HUDDLE_LLM_URL and HUDDLE_LLM_MODEL, to turn it on.');
  console.log(`  Answers as views: ${presenter.name === "rules" ? "tables only (set TYPESAFE_API_KEY or HUDDLE_LLM_* to choose views)" : `chosen by ${presenter.name}`}${writer ? `, charts, flowcharts, calculators and comparisons filled in by ${writer.model}` : ""}`);
  if (checker) console.log(`  Approvals that ask for it (check: true) have their facts checked on the web first: Tavily searches, ${fillModel} weighs the sources`);
  else if (tavilyKey) console.log("  TAVILY_API_KEY is set, but checking facts also needs a model: NEBIUS_API_KEY, or HUDDLE_LLM_URL and HUDDLE_LLM_MODEL.");
  if (env("CONTEXT_DEV_API_KEY")) console.log("  context.dev: contextdev assistants read pages, search the web and look companies up");
  if (monidKey) console.log(`  Monid: tool search in the canvas, and monid_find, monid_show, monid_run and monid_result on /mcp (up to $${monidMaxUsd} a run)`);
  if (guard) console.log(`  ${guard.name} checks every hand-off first (HUDDLE_GUARD=${env("HUDDLE_GUARD")}): a blocked one fails its run, a held one waits for your yes`);
  else if (env("ARMORIQ_API_KEY")) console.log("  ARMORIQ_API_KEY is set but no guard is on: set HUDDLE_GUARD=armoriq to have ArmorIQ check every hand-off.");
  const finds = [memory.embedder ? `words and meaning (${memory.embedder.model})` : "words", ...(memory.reranker ? [`reranked by ${memory.reranker.model}`] : [])];
  console.log(`  Memory: up to ${budget} characters of kept notes per request, found by ${finds.join(", ")}`);
  console.log(`  Learning from what you say: ${learner ? `${engine.learning() ? "on" : "off (turn it on in Memory)"}, read by ${learner.by}` : "needs a model (NEBIUS_API_KEY, or HUDDLE_LLM_*)"}`);
  console.log(`  Tidy up (Memory page): exact copies${llmUrl && fillModel ? `, and notes that say the same thing or disagree, read by ${fillModel} when you ask` : " only (set NEBIUS_API_KEY, or HUDDLE_LLM_*, for the rest)"}`);
  if (env("RESEND_WEBHOOK_SECRET")) {
    console.log(`  Email in: point Resend's inbound webhook (email.received) at ${publicUrl}/hooks/email`);
    if (!env("RESEND_API_KEY")) console.log("  ...but RESEND_API_KEY isn't set, so Huddle can't read the mail that arrives.");
    if (!env("HUDDLE_OWNER_EMAILS")) console.log("  Set HUDDLE_OWNER_EMAILS to your addresses, or your own mail counts as a stranger's.");
  }
  if (shell) {
    shell.health().then(
      ({ version: gatewayVersion }) => console.log(`  OpenShell gateway ${gatewayVersion} at ${shell?.gateway}: sandbox requests show in Approvals.`),
      (error: unknown) => console.log(`  OpenShell at ${shell?.gateway} isn't answering yet: ${error instanceof Error ? error.message : String(error)}`),
    );
  }
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") console.error(`Port ${port} is already in use (another Huddle?). Stop it, or set HUDDLE_PORT to a free port.`);
  else if (error.code === "EACCES") console.error(`Huddle isn't allowed to listen on ${host}:${port}. Pick a port above 1024 with HUDDLE_PORT.`);
  else console.error(error);
  store.close();
  process.exit(1);
});

function shutdown(): void {
  scheduler.stop();
  sandboxes?.stop();
  shell?.close();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  // Open event streams keep the server from closing; don't wait on them for long.
  setTimeout(() => process.exit(0), 3_000).unref();
}
websockets.injectWebSocket(server);
guardUpgrades(server);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
