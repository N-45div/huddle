import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Assistant, type Flow, parseFlow } from "@huddle/core";

/**
 * The example flows as templates the canvas offers: each with what it reaches and what it still needs
 * here (keys this server doesn't have), so a template you can't run yet says why before you try it.
 * They're read from examples/ (next to the packages in a checkout or the Docker image, next to the bundle
 * in the desktop app, or HUDDLE_EXAMPLES).
 */

export interface Template {
  /** Its file, without .json ("weekend-plan", "openshell-hermes/flow-nemotron"). */
  readonly id: string;
  readonly flow: Flow;
  /** What it reaches, by name: "NVIDIA Nemotron", "context.dev", ... */
  readonly uses: readonly string[];
  /** What this server still needs for it to run: key variables, or a service to set up. */
  readonly missing: readonly string[];
}

/** The ones worth trying first come first; any others follow by name. */
const ORDER = ["coffee-run", "weekend-plan", "read-it-for-me", "who-is-this", "bill-reader", "morning-brief", "inbox-digest", "job-hunt", "second-opinion", "openshell-hermes/flow-nemotron", "crew", "invoices"];

const NAMES: Partial<Record<Assistant["connector"], string>> = {
  nebius: "NVIDIA Nemotron",
  tavily: "Tavily",
  contextdev: "context.dev",
  monid: "Monid",
  openshell: "NVIDIA OpenShell",
  openclaw: "OpenClaw",
  hermes: "Hermes Agent",
  sochen: "Sochen",
  email: "Email (Resend)",
  openai: "an OpenAI-style model",
  ollama: "Ollama",
  vllm: "vLLM",
  mock: "stand-ins",
  shop: "a shop that sells to agents",
};

/** The key variable a connector reads when the assistant names none. */
const DEFAULT_KEY: Partial<Record<Assistant["connector"], string>> = {
  nebius: "NEBIUS_API_KEY",
  tavily: "TAVILY_API_KEY",
  contextdev: "CONTEXT_DEV_API_KEY",
  monid: "MONID_API_KEY",
  sochen: "SOCHEN_API_KEY",
  email: "RESEND_API_KEY",
  openclaw: "OPENCLAW_A2A_TOKEN",
  hermes: "HERMES_A2A_TOKEN",
};

function folder(): string | null {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [process.env.HUDDLE_EXAMPLES, join(here, "..", "..", "..", "examples"), join(here, "examples")];
  return candidates.find((path): path is string => Boolean(path && existsSync(path))) ?? null;
}

/** What a flow needs that this environment doesn't have. */
export function missingFor(flow: Flow, env: NodeJS.ProcessEnv = process.env): string[] {
  const missing = new Set<string>();
  for (const assistant of flow.assistants) {
    const key = assistant.keyEnv ?? DEFAULT_KEY[assistant.connector];
    if (key && !env[key]?.trim()) missing.add(key);
    if (assistant.connector === "openshell" && !env.HUDDLE_OPENSHELL_GATEWAY) missing.add("an OpenShell gateway (HUDDLE_OPENSHELL_GATEWAY)");
    // Bean & Leaf inside Huddle opens only with a PayPal app (or HUDDLE_SHOP=on, which can't charge).
    if (assistant.connector === "shop" && /\/shop\/?$/.test(assistant.url ?? "") && !(env.PAYPAL_CLIENT_ID?.trim() && env.PAYPAL_CLIENT_SECRET?.trim())) {
      missing.add("a PayPal sandbox app for the demo shop (PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET)");
    }
  }
  return [...missing];
}

export function readTemplates(env: NodeJS.ProcessEnv = process.env): Template[] {
  const root = folder();
  if (!root) return [];
  const files = readdirSync(root, { recursive: true, encoding: "utf8" })
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => file.endsWith(".json") && (!file.includes("/") || file.endsWith("/flow-nemotron.json")));
  const templates: Template[] = [];
  for (const file of files) {
    try {
      const flow = parseFlow(JSON.parse(readFileSync(join(root, file), "utf8")));
      const uses = [...new Set(flow.assistants.map((assistant) => NAMES[assistant.connector] ?? assistant.connector))];
      if (flow.steps.some((step) => step.type === "approval" && step.check)) uses.push("fact checks");
      if (flow.steps.some((step) => step.type === "pay")) uses.push("PayPal, signed on your board");
      templates.push({ id: file.slice(0, -".json".length), flow, uses, missing: missingFor(flow, env) });
    } catch {
      // Not a flow (or not a valid one): not a template.
    }
  }
  const rank = (id: string) => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length);
  return templates.sort((a, b) => rank(a.id) - rank(b.id) || a.flow.name.localeCompare(b.flow.name));
}
