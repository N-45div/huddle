import type { ConnectorInfo } from "./api-types.ts";

/** What the canvas's "add assistant" form shows for each connector: what it reaches and the fields it needs. */
export const CONNECTORS: readonly ConnectorInfo[] = [
  {
    id: "openclaw",
    name: "OpenClaw",
    description: "OpenClaw through its A2A channel. Turn on channels.a2a in OpenClaw with a peer token for Huddle; it's needed even on the same machine.",
    fields: [
      { key: "url", label: "Address", required: false, placeholder: "http://127.0.0.1:18789" },
      { key: "keyEnv", label: "Token variable", required: false, placeholder: "OPENCLAW_A2A_TOKEN" },
    ],
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    description: "Hermes Agent through its A2A gateway (port 9900). No token on the same machine; in Docker or elsewhere, set A2A_PEER_TOKENS and A2A_TRUSTED_PEERS in Hermes and the same token here.",
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
    id: "ollama",
    name: "Ollama",
    description: "A model running in Ollama, on this machine or on ollama.com. Pick one of the models it has; for ollama.com, give https://ollama.com and a key.",
    fields: [
      { key: "url", label: "Address", required: false, placeholder: "http://127.0.0.1:11434" },
      { key: "model", label: "Model", required: true, placeholder: "qwen3", suggest: "models" },
      { key: "keyEnv", label: "Key variable for ollama.com", required: false, placeholder: "OLLAMA_API_KEY" },
    ],
  },
  {
    id: "openshell",
    name: "Agent in an OpenShell sandbox",
    description:
      "Any agent with a one-shot command (Hermes, OpenCode, Claude Code, Codex…) running inside an NVIDIA OpenShell sandbox, whose policy decides what it may reach. Huddle passes the request on stdin, or where {{ask}} appears.",
    fields: [
      { key: "agentId", label: "Sandbox", required: true, placeholder: "my-agent" },
      { key: "command", label: "Command that runs the agent", required: true, placeholder: "hermes chat --query-file /dev/stdin --oneshot -Q" },
    ],
  },
  {
    id: "pact",
    name: "A business's agent (PACT)",
    description:
      "A company's support agent that speaks PACT, the Personal Agent Consent & Trust Protocol. Huddle signs each request as your personal agent; register Huddle with the company's Provider first.",
    fields: [
      { key: "url", label: "Agent Card URL", required: true, placeholder: "https://shop.example/.well-known/agent-card.json" },
      { key: "audience", label: "Provider's audience", required: true, placeholder: "https://provider.example/a2a" },
      { key: "scopes", label: "What it may do for you (optional)", required: false, placeholder: "orders:read orders:cancel" },
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
    id: "instinct",
    name: "Open Instinct",
    description: "An open-instinct agent, the personal agent you text, through its owner chat: Huddle talks to it as you. If it sets INSTINCT_CHAT_TOKEN, give Huddle the same token.",
    fields: [
      { key: "url", label: "Address", required: false, placeholder: "http://127.0.0.1:8080" },
      { key: "keyEnv", label: "Token variable", required: false, placeholder: "INSTINCT_CHAT_TOKEN" },
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
    fields: [{ key: "replies", label: "Fixed answers", required: false }],
  },
];
