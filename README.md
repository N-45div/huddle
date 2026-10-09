# Huddle

**n8n for personal assistants.** Connect the AI assistants you already use, give them one shared
memory, and draw how they hand work to each other, with you approving anything that matters.

> Status: early, and self-hosted. The canvas, the flow engine, shared memory, approvals, schedules,
> webhooks, "describe it", and connectors for OpenClaw, Hermes Agent, any A2A agent, OpenAI-style APIs,
> Home Assistant, Agent Zero and Sochen all work today, from one command or one container. Approvals on
> your phone and the hosted version are next. See [Roadmap](#roadmap).

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
- **Runs start how you like.** Press Run, put it on a schedule ("every 2h"), or give it a webhook
  address that anything can post to.
- **Your assistants can call it too.** Huddle is an A2A agent itself, so OpenClaw, Hermes or any other
  A2A assistant can hand a job to one of your flows.
- **Describe it.** Write the flow in a sentence; Huddle drafts it on the canvas for you to check.
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
| **`homeassistant`** | [Home Assistant](https://github.com/home-assistant/core)'s Assist, through its conversation API | ready |
| **`agentzero`** | [Agent Zero](https://github.com/agent0ai/agent-zero), through its external API | ready |
| **`http`** | anything with a simple `{ ask } → { text }` API | ready |
| **`mock`** | a stand-in assistant for building and testing flows | ready |
| `mcp` | assistants and tools exposed as Model Context Protocol servers | next |

"Ready" means built and tested against each project's documented API. OpenClaw (2026.9.9) and Hermes
Agent (0.21.6) are also tested against real installs: a flow where OpenClaw plans, you approve, and
Hermes follows up, each reading only its own slice of memory. The others haven't been run against a
live install yet, so reports of what breaks are very welcome. Assistants with no way in from outside
(some consumer apps have none) can't be connected yet; reaching them by email or a messaging channel is
on the roadmap.

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

Huddle finds OpenClaw at `http://127.0.0.1:18789` unless you give a `url`. OpenClaw always wants the
token, even on the same machine, and allows a peer 30 calls a minute; Huddle waits out that limit
rather than failing, but you can raise it with `channels.a2a.rateLimitPerMinute`.

**Hermes Agent.** Turn on its A2A gateway in its `config.yaml` (Hermes'
[A2A docs](https://hermes-agent.nousresearch.com/docs)):

```yaml
gateway:
  platforms:
    a2a:
      enabled: true
      extra:
        port: 9900
```

On the same machine it needs no token. Anywhere else, including in Docker, give Hermes a peer token and
trust it, in Hermes' environment:

```bash
A2A_PEER_TOKENS=huddle:<a long random token>
A2A_TRUSTED_PEERS=huddle
A2A_HOST=0.0.0.0        # Docker only: without a token Hermes listens inside its container only
```

and the same token as `HERMES_A2A_TOKEN` where Huddle runs. Then add it to a flow:

```json
{ "id": "hermes", "connector": "hermes", "memory": ["home"] }
```

A message sent to Hermes in its first few seconds after starting can come back empty; Huddle stops the
run with a message saying so, and running it again works.

**Anything with an OpenAI-style chat API.** Give its address, and the model or agent to ask for. If its
chat path isn't `/v1/chat/completions`, give the whole chat URL instead:

```json
{ "id": "webui", "connector": "openai", "url": "http://localhost:3000/api/chat/completions", "model": "my-agent", "keyEnv": "OPENWEBUI_KEY" }
```

**Sochen.** Set `SOCHEN_API_KEY` (a Pro plan's `sk_sochen_…` key) and add `{ "id": "sochen", "connector": "sochen" }`.

**Home Assistant.** Make a long-lived access token (your profile → Security), set it as `HASS_TOKEN`
where Huddle runs, and add Assist. `agentId` picks one of its conversation agents. Memory isn't sent to
it: Assist expects plain commands like "turn off the kitchen lights".

```json
{ "id": "home", "connector": "homeassistant", "url": "http://homeassistant.local:8123" }
```

**Agent Zero.** Turn on its external API (Settings → External Services), set the key as
`AGENT_ZERO_API_KEY`, and give its address. `agentId` picks an agent profile.

```json
{ "id": "zero", "connector": "agentzero", "url": "http://localhost:<its port>" }
```

### Also works with

These speak a protocol Huddle already has, so they need no connector of their own (set up from each
project's docs; tell us if one misbehaves):

| Assistant | Use | Notes |
|---|---|---|
| [nanobot](https://github.com/HKUDS/nanobot) | `openai`, `url` `http://127.0.0.1:8900` | `nanobot plugins enable api`, then `nanobot serve`; a key is needed only off localhost |
| [CowAgent](https://github.com/zhayujie/CowAgent) | `openai`, `url` `http://localhost:9899` | set `external_api_token` in its config, and the same value in your `keyEnv` |
| [OpenHands](https://github.com/OpenHands/OpenHands) | `openai`, `model` `openhands_<profile>` | its agent server's OpenAI gateway; a coding agent rather than a personal one |
| [ZeroClaw](https://github.com/zeroclaw-labs/zeroclaw) | `a2a`, `url` `http://<host>:42617/a2a/<alias>` | enable `[a2a.server]` and publish an alias; its pairing token goes in `keyEnv` |

Not reachable yet: Goose and QwenPaw speak ACP (planned); NanoClaw and PicoClaw only through a
messaging channel or a local socket.

An assistant only ever sees the memory slices it lists in `memory`. Keys always come from environment
variables, never from the flow file.

In Docker, `127.0.0.1` is the container itself: reach assistants running on the same machine at
`http://host.docker.internal:<port>` (the compose file sets that name up).

## Call Huddle from your assistants

Huddle is an A2A 1.0 agent too, so your assistants can start your flows. Every flow has its own
address, shown in its trigger settings: `<your Huddle>/a2a/flows/<flow id>`, with its own Agent Card.
Give that address to an assistant, with `HUDDLE_A2A_TOKEN` (or `HUDDLE_TOKEN`) as its Bearer token:

- What the assistant sends becomes the run's input. The reply is the run's last answer.
- A run that reaches an approval stays *working* until you answer it, since it's you who decides, not
  the assistant that asked. A "no" ends the task as *rejected*.

**Hermes Agent** calls other agents with its `a2a` toolset. Add Huddle's flow to its `config.yaml`:

```yaml
a2a_agents:
  huddle:
    url: "http://<your Huddle>/a2a/flows/<flow id>"
    auth: { type: bearer, token: "<HUDDLE_A2A_TOKEN>" }
    timeout: 120
```

then `hermes tools enable a2a --platform cli` (or your messaging platform), and ask it: *"Ask the huddle
agent to plan a walk for me tomorrow."* Hermes waits for the run and tells you its answer.

**OpenClaw** sends to peers on its A2A channel. Give the `huddle` peer the flow's address:

```json5
{ channels: { a2a: { enabled: true, peers: { huddle: {
  token: "${OPENCLAW_A2A_TOKEN}",                    // Huddle -> OpenClaw, as above
  url: "http://<your Huddle>/a2a/flows/<flow id>",  // OpenClaw -> Huddle
  outboundToken: "${HUDDLE_A2A_TOKEN}",
} } } } }
```

Anything OpenClaw sends to `a2a:huddle` then starts the flow, for example an agent turn delivered there:
`openclaw agent -m "Remind me to buy cat food tomorrow" --channel a2a --reply-to huddle --deliver`.
OpenClaw hands the message over and doesn't wait for the result, so end the flow with a step that
tells you, or that tells OpenClaw.

Both were tested live: Hermes asking a Huddle flow that asked OpenClaw, and OpenClaw sending to a Huddle
flow that asked Hermes. Any other A2A client can use `/a2a`, naming the flow in the message's metadata as
`"flow"`. While a token is set, Huddle's main card doesn't list your flows' names.

## Run it

Requires Node.js 24 or later.

```bash
git clone https://github.com/N-45div/huddle && cd huddle
npm install
npm run build          # builds the canvas
npm start              # http://localhost:7700
```

Open http://localhost:7700, make a flow (or, with a model set up, press **Describe it**), and press
**Run**. Runs that stop for
an approval wait in **Approvals**; what your assistants suggest remembering waits in **Memory**.

### With Docker

```bash
cp .env.example .env   # set HUDDLE_TOKEN (openssl rand -hex 32) and your assistants' keys
docker compose up -d   # http://localhost:7700, data in the huddle-data volume
```

### Settings

| Variable | Default | What it's for |
|---|---|---|
| `HUDDLE_TOKEN` | none | the token for the canvas and API; required unless Huddle listens on this machine only |
| `HUDDLE_HOST` | `127.0.0.1` | the address to listen on (`0.0.0.0` in Docker) |
| `HUDDLE_PORT` | `7700` | |
| `HUDDLE_DB` | `huddle.db` | where everything is kept (`/data/huddle.db` in Docker) |
| `HUDDLE_PUBLIC_URL` | `http://localhost:7700` | how others reach this Huddle, for webhook and A2A addresses |
| `HUDDLE_A2A_TOKEN` | `HUDDLE_TOKEN` | a separate token for assistants calling Huddle over A2A |
| `HUDDLE_LLM_URL`, `HUDDLE_LLM_MODEL`, `HUDDLE_LLM_KEY` | none | any OpenAI-compatible chat API (OpenAI, OpenRouter, Ollama, LM Studio) for "describe it" |

To reach Huddle from outside your machine, put it behind HTTPS (Caddy, Cloudflare Tunnel, Tailscale)
and set `HUDDLE_PUBLIC_URL`. Webhook addresses carry their own secret; make a new one from the flow's
trigger settings if one leaks.

### From the command line

```bash
npm run example                          # runs examples/invoices.json with stand-in assistants
npm run huddle -- approve <run-id> yes   # answer the approval it stops at
npm run huddle -- runs                   # recent runs
```

## Roadmap

1. The engine, shared memory, approvals and the first connectors (done)
2. OpenClaw, Hermes Agent, A2A, OpenAI-style, Home Assistant and Agent Zero connectors (done); MCP next
3. The canvas: drag assistants in, draw the hand-offs, watch runs live (done)
4. Schedules, webhooks, Huddle as an A2A agent, and "describe it" (done)
5. Approvals on your phone, and email and Telegram triggers
6. The hosted version, for people who'd rather not run anything

## License

[AGPL-3.0](LICENSE). You can use, change and self-host Huddle freely. If you run a changed version as a
service for others, you share your changes under the same license.
