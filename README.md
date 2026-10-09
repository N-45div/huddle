# Huddle

**n8n for personal assistants.** Connect the AI assistants you already use, give them one shared
memory, and draw how they hand work to each other, with you approving anything that matters.

> Status: early. The flow engine, shared memory, approvals and connectors for OpenClaw, Hermes Agent, any
> A2A agent, OpenAI-style APIs and Sochen run today from the command line. The canvas and the hosted
> version are being built. See [Roadmap](#roadmap).

---

## Why

You probably have more than one assistant already: one in your chat app, one that reads your email,
an open-source one running at home, a few that came with the tools you pay for. Each is good at
something. None of them talk to each other, and each one knows a different slice of your life.

Workflow tools like n8n can glue APIs together, but an assistant isn't an API call. It has its own
skills, its own memory and its own judgement, and it can be wrong. Huddle treats each assistant as a
teammate: you put them on a canvas, say who does what, and decide where you want a say.

## What it does

- **Assistants are the building blocks.** Each block on the canvas is a whole assistant, reached
  through a connector, rather than forty hand-wired API nodes.
- **One shared memory, with permissions.** Your assistants read from the same notes about you, and you
  choose which slice each one sees: your work bot gets your calendar, not your health notes. What an
  assistant learns goes in as a suggestion; only you make it part of the memory.
- **Approvals are a step, not a promise in a prompt.** Put an approval anywhere in a flow and the run
  stops there until you tap yes or no. Nothing that spends, sends or books gets past one without you.
- **Runs survive waiting.** A run that's waiting for your approval is saved, so it carries on later,
  after a restart, from exactly where it stopped.
- **Yours to host.** One command runs it on your own machine or server, with your data in one SQLite
  file. A hosted version is coming for people who'd rather not run anything.

## An example

> When an invoice email arrives, the finance assistant reads it and logs it. If it's over $200, ask me
> before paying. Then the calendar assistant adds a reminder for the due date.

```jsonc
{
  "name": "Invoices",
  "assistants": [
    { "id": "finance",  "connector": "sochen", "memory": ["money"] },
    { "id": "calendar", "connector": "http", "url": "http://localhost:8787/ask", "memory": ["calendar"] }
  ],
  "steps": [
    { "id": "read",   "type": "agent", "agent": "finance", "ask": "Read this invoice and give me the vendor, amount and due date as JSON: {{input}}" },
    { "id": "big",    "type": "condition", "if": "{{read.data.amount}} > 200", "then": "ask-me", "else": "remind" },
    { "id": "ask-me", "type": "approval", "message": "Pay {{read.data.vendor}} ${{read.data.amount}}?", "next": "remind" },
    { "id": "remind", "type": "agent", "agent": "calendar", "ask": "Add a reminder on {{read.data.due}} to pay {{read.data.vendor}}." },
    { "id": "learn",  "type": "memory", "slice": "money", "note": "{{read.data.vendor}} sends invoices." }
  ]
}
```

## Connectors

| Connector | Reaches | Status |
|---|---|---|
| **`openclaw`** | [OpenClaw](https://github.com/openclaw/openclaw), through its A2A channel | ready |
| **`hermes`** | [Hermes Agent](https://github.com/NousResearch/hermes-agent), through its A2A gateway | ready |
| **`a2a`** | any agent that speaks [A2A](https://a2a-protocol.org) 1.0 (Agent2Agent) | ready |
| **`openai`** | anything with an OpenAI-style chat API: Open WebUI, AnythingLLM, LibreChat's Agents API, Letta, and the API servers of OpenClaw and Hermes | ready |
| **`sochen`** | [Sochen](https://sochen.dev)'s agent and its pets, through the Agent API | ready |
| **`http`** | anything with a simple `{ ask } → { text }` API | ready |
| **`mock`** | a stand-in assistant for building and testing flows | ready |
| `mcp` | assistants and tools exposed as Model Context Protocol servers | next |

"Ready" means built and tested against each project's documented API; we haven't yet run every one
against a live install, so reports of what breaks are very welcome. Assistants with no way in from
outside (some consumer apps have none) can't be connected yet; reaching them by email or a messaging
channel is on the roadmap.

### Bring your assistant

**OpenClaw.** Turn on its A2A channel and give Huddle a token (OpenClaw's
[A2A docs](https://docs.openclaw.ai/channels/a2a.md)):

```json5
// in OpenClaw's config
{ channels: { a2a: { enabled: true, peers: { huddle: { token: "${OPENCLAW_A2A_TOKEN}" } } } } }
```

Then set the same `OPENCLAW_A2A_TOKEN` where Huddle runs, and add it to a flow:

```json
{ "id": "claw", "connector": "openclaw", "memory": ["work"] }
```

Huddle finds OpenClaw at `http://127.0.0.1:18789` unless you give a `url`.

**Hermes Agent.** Turn on its A2A gateway (`gateway.platforms.a2a.enabled: true`, port 9900; Hermes'
[A2A docs](https://hermes-agent.nousresearch.com/docs)). On the same machine it needs no token; for a
remote one, set a bearer token in Hermes and the same value in `HERMES_A2A_TOKEN` for Huddle.

```json
{ "id": "hermes", "connector": "hermes", "memory": ["home"] }
```

**Anything with an OpenAI-style chat API.** Give its address, and the model or agent to ask for. If its
chat path isn't `/v1/chat/completions`, give the whole chat URL instead:

```json
{ "id": "webui", "connector": "openai", "url": "http://localhost:3000/api/chat/completions", "model": "my-agent", "keyEnv": "OPENWEBUI_KEY" }
```

**Sochen.** Set `SOCHEN_API_KEY` (a Pro plan's `sk_sochen_…` key) and add `{ "id": "sochen", "connector": "sochen" }`.

An assistant only ever sees the memory slices it lists in `memory`. Keys always come from environment
variables, never from the flow file.

## Try it

Requires Node.js 24 or later.

```bash
git clone <repo> huddle && cd huddle
npm install
npm run example        # runs examples/invoices.json with stand-in assistants
```

The run stops at the approval step and prints its ID. Answer it:

```bash
npm run huddle -- approve <run-id> yes
```

## Roadmap

1. The engine, shared memory, approvals and the first connectors (done)
2. OpenClaw, Hermes Agent, A2A and OpenAI-style connectors (done); MCP next
3. The canvas: drag assistants in, draw the hand-offs, watch runs live
4. Triggers: schedules, webhooks, email and Telegram, with approvals on your phone
5. "Describe it": write the flow in a sentence and Huddle draws it
6. One-command self-hosting with Docker, then the hosted version

## License

[AGPL-3.0](LICENSE). You can use, change and self-host Huddle freely. If you run a changed version as a
service for others, you share your changes under the same license.
