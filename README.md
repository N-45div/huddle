# Huddle

**n8n for personal assistants.** Connect the AI assistants you already use, give them one shared
memory, and draw how they hand work to each other, with you approving anything that matters.

> Status: early, and self-hosted. The canvas, the flow engine, shared memory, approvals, schedules,
> webhooks, email in and out, "describe it", and connectors for OpenClaw, Hermes Agent, any A2A agent,
> OpenAI-style APIs, Ollama, agents in NVIDIA OpenShell sandboxes, Home Assistant, Agent Zero and Sochen
> all work today, from one command or one container. Approvals on
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
- **Runs start how you like.** Press Run, put it on a schedule ("every 2h"), give it a webhook
  address that anything can post to, or an email address: mail to it starts the flow.
- **Your assistants can call it too.** Huddle is an A2A agent itself, so OpenClaw, Hermes or any other
  A2A assistant can hand a job to one of your flows. And it's an MCP server, so Claude Code, Claude
  Desktop, Cursor or any MCP client gets your flows as tools.
- **One API to every assistant you run.** Huddle's router is OpenAI-compatible: point any app or SDK
  at it and the model name is your assistant (`"hermes"`, `"claw"`, or `"auto"` to let Huddle pick).
  Every call still gets only that assistant's memory, and shows in Runs.
- **Sandboxed assistants, with you holding the keys.** Run an agent inside an
  [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) sandbox and use it in a flow. When OpenShell
  blocks something the agent reaches for, the request lands in your Huddle approvals with OpenShell's
  own risk check, and the agent carries on once you allow it.
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

## Shared memory

Notes live in slices (`money`, `home`, `health`), and an assistant reads only the slices its `memory`
lists. What a flow or an assistant learns waits as a suggestion until you keep it. Passwords, card
numbers, one-time codes and keys stay out: they're masked in suggestions, and a note you write with
one is refused.

Each request carries the kept notes from the assistant's slices, up to 4,000 characters
(`HUDDLE_MEMORY_BUDGET`), with any note over 1,200 characters clipped. When the slices hold more than
that, the notes that match the request go first, then the newest. The matching is
[Sochen](https://sochen.dev)'s memory engine, ported to SQLite: a note scores by the request's words it
holds, each weighted by how rare it is among your notes (BM25's idf, without length scaling), so
"passport" outweighs a name that's in half of them. That works with nothing to set up. Two extras are
optional, from any provider:

- **Embeddings** (`HUDDLE_EMBED_URL`, `HUDDLE_EMBED_MODEL`, `HUDDLE_EMBED_KEY`, any OpenAI-compatible
  API): notes are found by meaning too, so "kitten" finds "Miso is a cat". Vectors stay in the same
  SQLite file.
- **A reranker** (`HUDDLE_RERANK_URL`, `HUDDLE_RERANK_MODEL`, `HUDDLE_RERANK_KEY`: Voyage, Cohere or
  Jina): reads the matches against the request and puts the best first.

If either is down, memory carries on without it, and a run never fails over memory. **Memory** on the
canvas has a search box that ranks notes the same way.

In Sochen, on Postgres with Voyage embeddings and reranking and a reader model for counting
questions, this engine scored 89.2% on LongMemEval. That number is Sochen's: Huddle has the ranking
but not the reader, stems words with SQLite's Porter stemmer rather than Postgres', and hasn't been
benchmarked yet.

## Connectors

| Connector | Reaches | Status |
|---|---|---|
| **`openclaw`** | [OpenClaw](https://github.com/openclaw/openclaw), through its A2A channel | ready |
| **`hermes`** | [Hermes Agent](https://github.com/NousResearch/hermes-agent), through its A2A gateway | ready |
| **`a2a`** | any agent that speaks [A2A](https://a2a-protocol.org) 1.0 (Agent2Agent) | ready |
| **`openai`** | anything with an OpenAI-style chat API: Open WebUI, AnythingLLM, LibreChat's Agents API, Letta, and the API servers of OpenClaw and Hermes | ready |
| **`ollama`** | a model in [Ollama](https://ollama.com), on your machine or on ollama.com | ready |
| **`openshell`** | any agent with a one-shot command (Hermes, OpenCode, Claude Code, Codex…) inside an [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) sandbox | ready |
| **`pact`** | a business's support agent over [PACT](https://github.com/openpactprotocol/openpactprotocol), with Huddle as your personal agent: its identity, and signing in to act for you | ready |
| **`sochen`** | [Sochen](https://sochen.dev)'s agent and its pets, through the Agent API | ready |
| **`homeassistant`** | [Home Assistant](https://github.com/home-assistant/core)'s Assist, through its conversation API | ready |
| **`agentzero`** | [Agent Zero](https://github.com/agent0ai/agent-zero), through its external API | ready |
| **`instinct`** | [Open Instinct](https://github.com/mariagorskikh/open-instinct), the personal agent you text, through its owner chat | ready |
| **`email`** | people, by email through [Resend](https://resend.com), always to the addresses you set (see [Email](#email)) | ready |
| **`http`** | anything with a simple `{ ask } → { text }` API | ready |
| **`mock`** | a stand-in assistant for building and testing flows | ready |
| `mcp` | assistants and tools exposed as Model Context Protocol servers | next |

"Ready" means built and tested against each project's documented API. OpenClaw (2026.9.9), Hermes
Agent (0.21.6) and Ollama (0.40) are also tested against real installs: a flow where OpenClaw plans, you
approve, and Hermes follows up, each reading only its own slice of memory, and a local model answering
from the slice it was given. PACT is tested against its reference Provider: Skyline Airways checked a flight,
asked for more permission to rebook it, and Huddle checked the signed receipt of each. The others haven't been run against a
live install yet, so reports of what breaks are very welcome. Assistants with no way in from outside
(some consumer apps have none) can't be connected yet, unless they read email (see [Email](#email));
reaching them by a messaging channel is on the roadmap.

**Open Instinct acts as its owner.** Everything Huddle sends it runs with its owner's full powers, whoever
started the flow. If contacts or strangers can start a flow that asks it (see [who can start a flow](#who-can-start-a-flow)),
put an approval step in front of that step.

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

**Ollama.** A local model, so a flow can run with nothing leaving your machine. With Ollama running,
add an assistant and pick one of the models it has (the canvas lists them), or in a flow file:

```json
{ "id": "local", "connector": "ollama", "model": "qwen3", "memory": ["home"] }
```

Huddle finds Ollama at `http://127.0.0.1:11434` unless you give a `url` (in Docker,
`http://host.docker.internal:11434`, with Ollama listening beyond loopback via `OLLAMA_HOST`). For
ollama.com's models, give `https://ollama.com` and put your key's variable in `keyEnv`
(`OLLAMA_API_KEY`). Ollama's default context is small on most machines; for long asks, raise
`OLLAMA_CONTEXT_LENGTH` where Ollama runs.

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

### Who can start a flow

`HUDDLE_A2A_TOKEN` is yours: whoever sends it acts as you. For other people and their agents, add them
under **Contacts**, closest first: partner, family, friend or contact. Each gets a token of their own
(shown once; Huddle keeps only its hash), which their agent sends the same way. Then each flow's Trigger
tab says who may start it:

- **Starts at once for** you, or a tier and everyone closer.
- **Contacts further away** wait for your OK: the run opens with an approval in Approvals, "Ravi
  (contact) wants to run *Dinner plans* with: …". Or turn them away.
- **People not in your contacts** are turned away by default, without learning whether the flow exists.
  A flow can let them ask instead, like a front desk.

Each contact sees only the tasks they started, a new token cuts the old one off at once, and every run's
log starts with who started it. Email works the same way, by the sender's address (see [Email](#email)).

## Use Huddle from Claude, Cursor or any MCP client

Huddle is an MCP server too, at `<your Huddle>/mcp`. Add it to Claude Code with `HUDDLE_A2A_TOKEN` (or
`HUDDLE_TOKEN`) as its Bearer token:

```bash
claude mcp add --transport http huddle http://localhost:7700/mcp --header "Authorization: Bearer $HUDDLE_A2A_TOKEN"
```

Claude Desktop and Cursor take it through [mcp-remote](https://github.com/geelen/mcp-remote), in
`claude_desktop_config.json` or `.cursor/mcp.json` (Cursor also takes `url` and `headers` directly):

```json
{ "mcpServers": { "huddle": {
  "command": "npx",
  "args": ["-y", "mcp-remote", "http://localhost:7700/mcp", "--header", "Authorization:${HUDDLE_AUTH}"],
  "env": { "HUDDLE_AUTH": "Bearer <your HUDDLE_A2A_TOKEN>" }
} } }
```

On a Huddle with no token (this machine only), leave the header out. The **Assistants** page has both,
filled in, under **Use it from any app**. Then these tools appear:

- **A tool per flow**, named after it (`flow_plan_a_walk`; each flow's Trigger tab shows its tool) and
  described by the flow's description. What the client gives as `input` becomes the run's input. The
  tool waits up to 50 seconds for the run and answers with what it said.
- **`get_run`** follows a run started over MCP, by the run id a flow tool answered with.
- **`ask_assistant`** asks one of your assistants through the [router](#the-router-one-api-to-every-assistant-you-run),
  by its id or `"auto"`, with only its memory slices, and **`list_assistants`** lists them. They're for
  your token only, since your assistants act for you.

Approvals still come to you. A run that reaches an approval comes back *waiting*, saying what for, with
its run id; answer it in **Approvals**, and `get_run` then has the answer. A run that takes longer than
the wait comes back *still running* the same way.

Trust tiers apply as on A2A ([Who can start a flow](#who-can-start-a-flow)): your token sees every flow.
A contact's own token sees only the flows their tier may start or ask you for (their runs open with an
approval saying who wants what), and `get_run` shows them only the runs they started. People not in
your contacts get a 401, unless a flow lets strangers ask: then they see that flow's tool and nothing
else. Every run's log says who started it, over MCP.

`/mcp` speaks MCP's current revision (2026-07-28, where each request carries its version) and the
earlier ones most clients still send (2025-11-25 and 2025-06-18, which open with `initialize`), with no
sessions: one JSON-RPC request per POST, answered in plain JSON. Checked with Claude Code (it connects),
the official TypeScript SDK's clients (v1, and v2 in both revisions) and the MCP conformance suite's
initialize, ping, tools and DNS-rebinding checks.

## Email

Huddle sends and receives mail through [Resend](https://resend.com), a hosted email API (there's no
Resend server to run yourself).

**Sending.** The `email` connector sends a step's text as an email, always to the addresses you give it,
from an address on a domain you verified in Resend:

```json
{ "id": "mail-asha", "connector": "email", "to": ["asha@example.com"], "from": "Huddle <huddle@yourdomain.com>" }
```

- Start the step's text with `Subject: …` to give the email a subject; the rest is the message. Without
  it, the subject is "A message from Huddle".
- The key comes from `RESEND_API_KEY`, or the variable you name in `keyEnv`.
- No memory goes out: only what the step says is in the email.
- **Put an approval step before an email step**, so nothing leaves without your OK:

```jsonc
{ "id": "check", "type": "approval", "message": "Send this to Asha?\n\n{{draft.text}}" },
{ "id": "send",  "type": "agent", "agent": "mail-asha", "ask": "Subject: Saturday\n\n{{draft.text}}" }
```

The router's `"auto"` never picks an email assistant; ask for one by its id if you mean it.

**Receiving.** A flow whose trigger is **When an email arrives** starts when mail to its address reaches
Huddle:

```jsonc
"trigger": { "type": "email", "address": "inbox@yourdomain.com" }
```

1. In Resend, turn on receiving: any address at the `<id>.resend.app` domain Resend gives you works at
   once, or add Resend's MX record to receive at your own domain.
2. Add a webhook for the `email.received` event pointing at `<HUDDLE_PUBLIC_URL>/hooks/email`, one
   address for all your flows (Huddle has to be reachable from the internet, e.g. through a tunnel).
3. Where Huddle runs, set `RESEND_WEBHOOK_SECRET` to the webhook's signing secret (`whsec_…`) and
   `RESEND_API_KEY` to a full-access key. The event only names the mail; Huddle fetches it with the key,
   and a sending-only key can't read mail.
4. Set `HUDDLE_OWNER_EMAILS` to your own addresses.

The email is the run's input: its plain text (or its HTML as text when there's none), up to 100,000
characters, after who it's from, who it's to and the subject:

```
From: Asha <asha@example.com>
To: inbox@yourdomain.com
Subject: Saturday?

Are you free for lunch?
```

Who sent it decides what happens, under the flow's **Who can start it from outside** rule, as for A2A:
mail from your addresses counts as you, mail from an address one of your **Contacts** has counts as them
at their tier, and anyone else is a stranger. Strangers are turned away unless the flow lets them ask, and
turned-away mail is dropped with a line in Huddle's log. A From line is easy to forge, so a sender only
counts as you or a contact when the receiving mail server found the mail really came from their domain
(DKIM or DMARC passed); otherwise it's a stranger's. Every event must carry the webhook's signature and
be less than five minutes old, and each one starts its runs once, however often Resend sends it again.

Both directions are built from Resend's API docs and tested against stand-ins; they haven't run against a
live Resend account yet, so reports are welcome.

## Sandboxed assistants with NVIDIA OpenShell

[OpenShell](https://github.com/NVIDIA/OpenShell) runs an agent in a sandbox whose policy decides what it
may read and which hosts it may reach, and it keeps model keys outside: the agent only ever sees a
placeholder, and OpenShell adds the real key to requests it has approved. Connect Huddle to your
OpenShell gateway and:

- **An agent in a sandbox is a flow's assistant.** Anything with a one-shot command works. Huddle sends
  the request (and the memory that assistant may read) on stdin, or where `{{ask}}` appears in the
  command.
- **What the sandbox asks for comes to you.** When OpenShell blocks a connection, it drafts a rule.
  Huddle shows it in **Approvals** as, say, "python3.14 wants to reach api.openai.com:443", with
  OpenShell's own risk check in plain words. Allow it and the sandbox loads the rule within a few
  seconds, so the agent carries on in the same run; deny it and it stays blocked.

Tell Huddle where the gateway is, and where the OpenShell CLI's client certificate is:

```bash
HUDDLE_OPENSHELL_GATEWAY=https://127.0.0.1:8080
OPENSHELL_TLS_DIR=~/.config/openshell/gateways/openshell/mtls   # the default
```

(In Docker, use `https://host.docker.internal:8080` and mount that folder read-only, e.g. at `/certs`.)

Then add the assistant, naming its sandbox and the command that runs it. For Hermes Agent:

```json
{ "id": "hermes", "connector": "openshell", "agentId": "hermes-agent", "memory": ["home"],
  "command": ["env", "HERMES_HOME=/tmp/hermes", "/opt/hermes/bin/hermes", "--provider", "openai-api",
              "chat", "--query-file", "/dev/stdin", "--oneshot", "-Q", "-m", "gpt-5.4-mini"] }
```

[`examples/openshell-hermes`](examples/openshell-hermes) has the image, policy and flow for that,
tested with OpenShell 0.1.2 and Hermes Agent 0.21.6 on Windows (WSL 2 and Docker Desktop):

```bash
docker build -t huddle/hermes-sandbox:local examples/openshell-hermes
openshell provider create --name openai --type openai --from-existing        # reads OPENAI_API_KEY
openshell sandbox create --name hermes-agent --from huddle/hermes-sandbox:local --provider openai \
  --policy examples/openshell-hermes/policy.yaml --no-tty --detach -- sleep infinity
```

A sandbox image needs a few things OpenShell checks: a non-root user, a working directory that user
can write, and a single-platform image (on Docker Desktop, a one-line `FROM` build gives you one). The
policy has to let the sandbox read the agent's install: sandboxes start with only system paths.

## The router: one API to every assistant you run

Like OpenRouter for models, but for your assistants, with your memory and your approvals in the middle.
Set your assistants up once (`PUT /api/assistants`), each with a one-line description of what it's good
at, then use any OpenAI SDK:

```js
import OpenAI from "openai";
const huddle = new OpenAI({ baseURL: "http://localhost:7700/v1", apiKey: process.env.HUDDLE_ROUTER_KEY });

await huddle.chat.completions.create({ model: "hermes", messages: [{ role: "user", content: "What's my cat called?" }] });
await huddle.chat.completions.create({ model: "auto", messages: [{ role: "user", content: "Fit a walk around my meetings" }] });
await huddle.chat.completions.create({ model: "claw", models: ["hermes"], messages: [/* … */] }); // falls back to hermes
```

- `GET /v1/models` lists your assistants, plus `auto`.
- `model: "auto"` asks a judge which assistant fits: [Jev](https://docs.typesafe.ai) with your
  `TYPESAFE_API_KEY` (one calibrated choice over your assistants' descriptions, a probability for each),
  or else your "describe it" model. The answer says how it was routed (`huddle.route`).
- `models: [...]` are fallbacks in order, as on OpenRouter. The answer says what was skipped and why.
- Each assistant only ever sees its own memory slices, whoever calls. Calls show in **Runs**.
- `/v1` takes `HUDDLE_ROUTER_KEY` or `HUDDLE_TOKEN` as a Bearer key. Streaming works.
- The canvas's **Assistants** page holds the list, with calls, failures and speed per assistant, a
  **Try it** box that shows how "auto" judged, and the code to call it. Flows add assistants from it.

**Spending less.** Give an assistant its price (dollars per million tokens in and out, or per call) and
Huddle counts what every hand-off costs, from the assistant's own token counts where it reports them
(OpenAI-style APIs, OpenRouter's exact cost, Ollama) and from the text's length where it doesn't. Then:

- **Cheaper picks.** "Auto" asks the cheapest of the assistants that fit nearly as well as the best (at
  least 60% of the top one's probability). `huddle: { prefer: "quality" }` keeps the judge's order;
  `"cheapest"` reaches further. The answer says when a cheaper one went first, and what each would cost.
- **Sticky conversations.** A later turn goes back to the assistant that answered the conversation for
  ten minutes, without asking the judge again, so that assistant's prompt cache stays warm.
- **Answers given again.** An assistant can give the very same question the same answer for a while
  (`reuseMinutes`), and only while nothing it may read has changed. Opt-in, router only; `Cache-Control:
  no-cache` asks afresh. Leave it off for assistants that act.
- **A cap per answer** (`maxTokens`, for OpenAI-style and Ollama assistants) and **a budget**
  (`HUDDLE_BUDGET=20/month`): past 80% "auto" goes for the cheapest; once it's spent, assistants with a
  price wait (flows' steps fail saying so, `/v1` answers 429) while free ones carry on.
- `usage` in `/v1` answers is real, and **Assistants** shows this period's spend against the budget and
  what kept answers and cheaper picks saved.

Tested with the OpenAI Node SDK against OpenClaw, Hermes, a local Ollama model and Hermes in an
OpenShell sandbox: "auto" sent a work question to OpenClaw, "what's my cat called?" to Hermes, and small
talk to the local model. [docs/ROUTER.md](docs/ROUTER.md) has the design.

## Talk to businesses as your personal agent (PACT)

[PACT](https://github.com/openpactprotocol/openpactprotocol), the Personal Agent Consent & Trust
Protocol, is how a personal agent talks to a company's support agent with the person's permission. It's
built on A2A 1.0 and OAuth. Huddle speaks it as your personal agent:

- **Huddle has its own identity.** On first start it makes an ES256 key and keeps it in its database;
  the public half is at `{your Huddle}/.well-known/jwks.json`. Every message to a business carries a
  short-lived token Huddle signs, so the business knows which agent is asking and for whom (an opaque
  id, never your name or email).
- **A business's agent is a flow's assistant.** Give it the business's Agent Card URL and its
  Provider's audience. Steps in one run carry on the same conversation, so when the agent asks "what's
  the order number?" the next step can answer.
- **Register once per Provider.** For Providers with self-service registration like PACT's reference
  one: `POST /api/pact/register { "provider": "https://provider.example", "name": "my-huddle" }`.
  Others take your issuer and `jwks.json` address by hand.

```json
{ "id": "loom", "connector": "pact",
  "url": "https://provider.example/a2a/<brand>/.well-known/agent-card.json",
  "audience": "https://provider.example/a2a" }
```

Businesses must reach your Huddle's `jwks.json` over the internet, so set `HUDDLE_PUBLIC_URL` (or
`HUDDLE_PACT_ISSUER`) to a public HTTPS address, e.g. through a tunnel.

**Signing in, so a business's agent can act for you** (PACT's delegated authority):

- List what you'll allow in the assistant's `scopes` (the ids on the business's card, like
  `flights:upcoming:read`). The first time a step needs them, Approvals shows the business's own sign-in
  link and what it would let Huddle do, in the business's words. You sign in on its page; Huddle never
  sees your password. The step carries on by itself once you approve, and the permission is kept for
  next time.
- If the business needs more mid-conversation ("I need permission to rebook"), Huddle asks you for just
  that, then carries on in the same conversation.
- Every answer comes with a receipt the business signed: what it did and with which permission. Huddle
  checks the signature and the run log says "signed receipt checked", or warns when it doesn't hold.

Tested against PACT's reference Provider: Skyline Airways checked a flight, asked for permission to
rebook, and rebooked it, with both receipts checked.

## Every hand-off checked first, with ArmorIQ

Huddle lets your assistants hand each other work, and some of that work matters: an email sent, a
booking changed, a shell run. With [ArmorIQ](https://armoriq.ai), every hand-off is checked before it is
made, against a plan signed when the run started and a policy you keep on ArmorIQ, outside Huddle and
outside any model. Block a connector there and no flow, contact or router call can use it; set one to
hold and it waits for your yes; every decision lands in ArmorIQ's audit log.

- When a run starts, its flow's hand-offs go to ArmorIQ as a plan, which comes back signed.
- Before each hand-off, Huddle asks ArmorIQ about it. One that wasn't in the plan, or that your policy
  doesn't allow, is **stopped**: the run fails with ArmorIQ's reason, and the assistant never hears of it.
  One your policy **holds** waits in Approvals for your yes. The rest go ahead.
- Router calls are checked the same way. The run log shows each verdict and the policy that gave it.
- ArmorIQ sees which assistant each step goes to (as the tool `huddle__<connector>`), how long the
  answer was and how long it took. It never sees what was asked or the answer.
- If ArmorIQ can't be reached, nothing is handed off.

Set it up once:

```bash
export ARMORIQ_API_KEY=ak_live_...                 # Settings, API Keys on platform.armoriq.ai
npm run huddle -- armoriq register                 # every connector allowed
npm run huddle -- armoriq register --deny instinct,openshell   # or block some
npm start
```

To have a hand-off wait for you, say `huddle.email`, set that tool to hold on ArmorIQ's dashboard
(Policies, `cli-huddle-huddle`). Registering again won't wipe that unless you add `--replace`.

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
| `HUDDLE_A2A_TOKEN` | `HUDDLE_TOKEN` | a separate token for assistants and MCP clients calling Huddle over A2A or MCP |
| `HUDDLE_LLM_URL`, `HUDDLE_LLM_MODEL`, `HUDDLE_LLM_KEY` | none | any OpenAI-compatible chat API (OpenAI, OpenRouter, Ollama, LM Studio) for "describe it" |
| `HUDDLE_MEMORY_BUDGET` | `4000` | characters of kept notes each request carries; past that, the notes that match it go first |
| `HUDDLE_EMBED_URL`, `HUDDLE_EMBED_MODEL`, `HUDDLE_EMBED_KEY` | none | any OpenAI-compatible embeddings API, so memory finds notes by meaning too |
| `HUDDLE_RERANK_URL`, `HUDDLE_RERANK_MODEL`, `HUDDLE_RERANK_KEY` | none | a rerank API (Voyage, Cohere, Jina) that orders the notes memory finds |
| `HUDDLE_ROUTER_KEY` | `HUDDLE_TOKEN` | a key just for the router's `/v1` |
| `TYPESAFE_API_KEY`, `HUDDLE_JEV_MODEL` | none, `jev-latest` | Jev judges the router's `"auto"` |
| `HUDDLE_OPENSHELL_GATEWAY` | none | an NVIDIA OpenShell gateway, for sandboxed assistants and their requests in Approvals |
| `OPENSHELL_TLS_DIR` | `~/.config/openshell/gateways/openshell/mtls` | the OpenShell CLI's client certificate (`ca.crt`, `tls.crt`, `tls.key`) |
| `RESEND_API_KEY` | none | sends email (the `email` connector's default key) and reads mail that arrives; reading needs a full-access key |
| `RESEND_WEBHOOK_SECRET` | none | the signing secret of Resend's `email.received` webhook, pointed at `/hooks/email`; without it Huddle takes no mail |
| `HUDDLE_OWNER_EMAILS` | none | your own addresses, comma-separated: mail from them counts as you |
| `HUDDLE_BUDGET` | none | a cap on what assistants with a price may spend, in US dollars: `20/month` or `5/day` |
| `ARMORIQ_API_KEY` | none | ArmorIQ checks every hand-off first (see [above](#every-hand-off-checked-first-with-armoriq)) |
| `HUDDLE_ARMORIQ_AGENT` | `huddle` | the agent your ArmorIQ policies are for |

To reach Huddle from outside your machine, put it behind HTTPS (Caddy, Cloudflare Tunnel, Tailscale)
and set `HUDDLE_PUBLIC_URL`. Webhook addresses carry their own secret; make a new one from the flow's
trigger settings if one leaks.

### From the command line

```bash
npm run example                          # runs examples/invoices.json with stand-in assistants
npm run huddle -- approve <run-id> yes   # answer the approval it stops at
npm run huddle -- runs                   # recent runs
npm run huddle -- armoriq register       # set up ArmorIQ's policy for Huddle
```

## Roadmap

1. The engine, shared memory, approvals and the first connectors (done)
2. OpenClaw, Hermes Agent, A2A, OpenAI-style, Home Assistant and Agent Zero connectors (done); MCP next
3. The canvas: drag assistants in, draw the hand-offs, watch runs live (done)
4. Schedules, webhooks, Huddle as an A2A agent and an MCP server, "describe it", and trust tiers for who may start a flow (done)
5. Ollama, and sandboxed assistants with NVIDIA OpenShell, their requests in your approvals (done)
6. The router: one OpenAI-compatible API to every assistant, "auto" judged by Jev, fallbacks, and
   spending less: cheaper picks, sticky conversations, answers given again, a budget (done); keys per app next
7. PACT: Huddle as your personal agent with businesses, its identity and signing in from Approvals (done),
   and Sierra and Meta's Personal Agent Protocol when its v0.1 spec is out
8. Email in and out through Resend (done); approvals on your phone and a Telegram trigger next
9. Every hand-off checked against a signed plan and your policy with ArmorIQ (done)
10. The hosted version, for people who'd rather not run anything

## License

[AGPL-3.0](LICENSE). You can use, change and self-host Huddle freely. If you run a changed version as a
service for others, you share your changes under the same license.
