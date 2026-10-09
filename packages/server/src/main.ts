import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { defaultConnectors, Engine, Store } from "@huddle/core";
import { createApp } from "./app.ts";
import { describer } from "./describe.ts";
import { Scheduler } from "./scheduler.ts";
import { webApp } from "./static.ts";

/**
 * Starts Huddle: the canvas, the API, webhooks, schedules and the A2A endpoint, from one process and
 * one SQLite file. Everything is set with environment variables:
 *
 *   HUDDLE_DB          where to keep everything (default huddle.db)
 *   HUDDLE_HOST        the address to listen on (default 127.0.0.1, this machine only)
 *   HUDDLE_PORT        default 7700
 *   HUDDLE_TOKEN       the token for the canvas and API; required unless listening on this machine only
 *   HUDDLE_PUBLIC_URL  how others reach this Huddle, for webhook and A2A addresses
 *   HUDDLE_A2A_TOKEN   a separate token for assistants calling Huddle over A2A (default HUDDLE_TOKEN)
 *   HUDDLE_LLM_URL, HUDDLE_LLM_MODEL, HUDDLE_LLM_KEY   an OpenAI-compatible model for "describe it"
 *   HUDDLE_WEB         the built canvas to serve (default packages/web/dist)
 */

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;
const host = env("HUDDLE_HOST") ?? "127.0.0.1";
const port = Number(env("HUDDLE_PORT") ?? 7700);
const token = env("HUDDLE_TOKEN");
const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";

if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`HUDDLE_PORT must be a port number, not "${env("HUDDLE_PORT")}".`);
if (!loopback && !token) {
  console.error(`Huddle won't listen on ${host} without a token: anyone who reaches it could run your assistants.\nSet HUDDLE_TOKEN to a long random string (e.g. openssl rand -hex 32), or listen on 127.0.0.1.`);
  process.exit(1);
}
if (token && token.length < 16) {
  console.error("HUDDLE_TOKEN is too short; use at least 16 characters (e.g. openssl rand -hex 32).");
  process.exit(1);
}

const llmUrl = env("HUDDLE_LLM_URL");
const llmModel = env("HUDDLE_LLM_MODEL");
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const publicUrl = (env("HUDDLE_PUBLIC_URL") ?? `http://${loopback || host === "0.0.0.0" || host === "::" ? "localhost" : host}:${port}`).replace(/\/$/, "");

const store = new Store(env("HUDDLE_DB") ?? "huddle.db");
const interrupted = store.failInterrupted();
if (interrupted) console.log(`[huddle] ${interrupted} run(s) were cut off when Huddle last stopped; marked failed.`);
const engine = new Engine(store, defaultConnectors());
const scheduler = new Scheduler(store, engine);

const app = createApp({
  store,
  engine,
  version,
  publicUrl,
  token,
  a2aToken: env("HUDDLE_A2A_TOKEN"),
  describe: llmUrl && llmModel ? describer({ url: llmUrl, model: llmModel, key: env("HUDDLE_LLM_KEY") }) : undefined,
});
app.use("*", webApp(env("HUDDLE_WEB") ?? fileURLToPath(new URL("../../web/dist", import.meta.url))));

const server = serve({ fetch: app.fetch, hostname: host, port }, () => {
  scheduler.start();
  console.log(`Huddle ${version} is on ${publicUrl}${token ? " (token required)" : ""}`);
  console.log(`  A2A Agent Card: ${publicUrl}/.well-known/agent-card.json`);
  if (!llmUrl || !llmModel) console.log('  "Describe it" is off: set HUDDLE_LLM_URL and HUDDLE_LLM_MODEL to turn it on.');
});

function shutdown(): void {
  scheduler.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  // Open event streams keep the server from closing; don't wait on them for long.
  setTimeout(() => process.exit(0), 3_000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
