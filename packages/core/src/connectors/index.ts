import type { Connector } from "../connector.ts";
import { a2a } from "./a2a.ts";
import { agentzero } from "./agentzero.ts";
import { cli } from "./cli.ts";
import { email } from "./email.ts";
import { homeassistant } from "./homeassistant.ts";
import { http } from "./http.ts";
import { instinct } from "./instinct.ts";
import { mock } from "./mock.ts";
import { monid } from "./monid.ts";
import { nebius } from "./nebius.ts";
import { tavily } from "./tavily.ts";
import { contextdev } from "./contextdev.ts";
import { ollama } from "./ollama.ts";
import { openshell } from "./openshell.ts";
import { pact } from "./pact.ts";
import { openai } from "./openai.ts";
import { vllm } from "./vllm.ts";
import { sochen } from "./sochen.ts";

/** Every connector Huddle ships, by the name a flow file uses. openclaw and hermes are A2A presets. */
export function defaultConnectors(): Readonly<Record<string, Connector>> {
  const agentToAgent = a2a();
  return {
    mock,
    http: http(),
    sochen: sochen(),
    a2a: agentToAgent,
    openclaw: agentToAgent,
    hermes: agentToAgent,
    openai: openai(),
    ollama: ollama(),
    vllm: vllm(),
    nebius: nebius(),
    tavily: tavily(),
    contextdev: contextdev(),
    cli: cli(),
    openshell: openshell(),
    pact: pact(() => null),
    homeassistant: homeassistant(),
    agentzero: agentzero(),
    instinct: instinct(),
    email: email(),
    monid: monid(),
  };
}
