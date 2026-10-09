import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { defaultConnectors, Engine, OpenShell, openshell, Store } from "@huddle/core";
import { createApp } from "./app.ts";
import { describer } from "./describe.ts";
import { SandboxWatcher } from "./sandbox-requests.ts";
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
 *   HUDDLE_OPENSHELL_GATEWAY  an NVIDIA OpenShell gateway (e.g. https://127.0.0.1:8080), for sandboxed
 *                      assistants and their requests in the approvals inbox; OPENSHELL_TLS_DIR holds its
 *                      client certificate (default ~/.config/openshell/gateways/openshell/mtls)
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
let shell: OpenShell | null;
try {
  shell = OpenShell.fromEnv();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const engine = new Engine(store, { ...defaultConnectors(), openshell: openshell(() => shell) });
const sandboxes = shell ? new SandboxWatcher(shell, store) : undefined;
const scheduler = new Scheduler(store, engine);

const app = createApp({
  store,
  engine,
  version,
  publicUrl,
  token,
  a2aToken: env("HUDDLE_A2A_TOKEN"),
  describe: llmUrl && llmModel ? describer({ url: llmUrl, model: llmModel, key: env("HUDDLE_LLM_KEY") }) : undefined,
  sandboxes,
});
const web = env("HUDDLE_WEB") ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
const built = existsSync(join(web, "index.html"));
app.use("*", webApp(web));
if (!built) app.get("/", (c) => c.text("Huddle is running, but the canvas isn't built yet: run npm run build, then restart.", 503));

const server = serve({ fetch: app.fetch, hostname: host, port }, () => {
  scheduler.start();
  sandboxes?.start();
  console.log(`Huddle ${version} is on ${publicUrl}${token ? " (token required)" : ""}`);
  console.log(`  A2A Agent Card: ${publicUrl}/.well-known/agent-card.json`);
  if (!built) console.log(`  The canvas isn't built (no ${join(web, "index.html")}): run npm run build.`);
  if (!llmUrl || !llmModel) console.log('  "Describe it" is off: set HUDDLE_LLM_URL and HUDDLE_LLM_MODEL to turn it on.');
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
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
