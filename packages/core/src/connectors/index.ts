import type { Connector } from "../connector.ts";
import { a2a } from "./a2a.ts";
import { agentzero } from "./agentzero.ts";
import { homeassistant } from "./homeassistant.ts";
import { http } from "./http.ts";
import { mock } from "./mock.ts";
import { openai } from "./openai.ts";
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
    homeassistant: homeassistant(),
    agentzero: agentzero(),
  };
}
