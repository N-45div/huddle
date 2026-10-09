import type { ConnectorInfo } from "./api-types.ts";

/** What the canvas's "add assistant" form shows for each connector: what it reaches and the fields it needs. */
export const CONNECTORS: readonly ConnectorInfo[] = [
  {
    id: "openclaw",
    name: "OpenClaw",
    description: "OpenClaw through its A2A channel. Turn on channels.a2a in OpenClaw and give Huddle a peer token.",
    fields: [
      { key: "url", label: "Address", required: false, placeholder: "http://127.0.0.1:18789" },
      { key: "keyEnv", label: "Token variable", required: false, placeholder: "OPENCLAW_A2A_TOKEN" },
    ],
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    description: "Hermes Agent through its A2A gateway (port 9900). No token is needed on the same machine.",
    fields: [
      { key: "url", label: "Address", required: false, placeholder: "http://127.0.0.1:9900" },
      { key: "keyEnv", label: "Token variable", required: false, placeholder: "HERMES_A2A_TOKEN" },
    ],
  },
  {
    id: "a2a",
    name: "Any A2A agent",
    description: "Any agent that speaks A2A 1.0. Huddle reads its Agent Card to find where to send work.",
    fields: [
      { key: "url", label: "Address or Agent Card URL", required: true, placeholder: "https://agent.example.com" },
      { key: "keyEnv", label: "Token variable", required: false, placeholder: "MY_AGENT_TOKEN" },
    ],
  },
  {
    id: "openai",
    name: "OpenAI-style chat API",
    description: "Open WebUI, AnythingLLM, LibreChat, Letta, nanobot, CowAgent, OpenHands, and the API servers of OpenClaw and Hermes.",
    fields: [
      { key: "url", label: "Address (or the full chat URL)", required: true, placeholder: "http://localhost:8900" },
      { key: "model", label: "Model or agent", required: false, placeholder: "openclaw/main" },
      { key: "keyEnv", label: "Key variable", required: false, placeholder: "MY_ASSISTANT_KEY" },
    ],
  },
  {
    id: "homeassistant",
    name: "Home Assistant",
    description: "Home Assistant's Assist. Takes plain commands; memory isn't sent to it.",
    fields: [
      { key: "url", label: "Address", required: false, placeholder: "http://homeassistant.local:8123" },
      { key: "keyEnv", label: "Token variable", required: false, placeholder: "HASS_TOKEN" },
      { key: "agentId", label: "Conversation agent", required: false, placeholder: "conversation.home_assistant" },
    ],
  },
  {
    id: "agentzero",
    name: "Agent Zero",
    description: "Agent Zero through its external API (Settings → External Services).",
    fields: [
      { key: "url", label: "Address", required: true, placeholder: "http://localhost:<port>" },
      { key: "keyEnv", label: "Key variable", required: false, placeholder: "AGENT_ZERO_API_KEY" },
      { key: "agentId", label: "Agent profile", required: false },
    ],
  },
  {
    id: "sochen",
    name: "Sochen",
    description: "Sochen's agent and its pets, through the Agent API (a Pro plan key).",
    fields: [{ key: "keyEnv", label: "Key variable", required: false, placeholder: "SOCHEN_API_KEY" }],
  },
  {
    id: "http",
    name: "Simple HTTP",
    description: "Anything that takes { ask, memory } and answers { text, data? }.",
    fields: [
      { key: "url", label: "Address", required: true, placeholder: "http://localhost:8787/ask" },
      { key: "keyEnv", label: "Key variable", required: false },
    ],
  },
  {
    id: "mock",
    name: "Stand-in",
    description: "Answers from a fixed list, for building and testing a flow.",
    fields: [{ key: "replies", label: 'Replies (JSON: { "keyword": "answer", "*": "otherwise" })', required: false }],
  },
];
