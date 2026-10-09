# How Huddle works

Huddle runs **flows**: a trigger, then steps that hand work between **assistants**, read and suggest
**memory**, branch on **conditions** and stop for **approvals**. Everything a run needs to carry on
later is saved in one SQLite file, so a run waiting on you survives a restart.

## Assistants

An assistant is anything Huddle can send a request to and get an answer back from.

```jsonc
{ "id": "finance", "name": "Finance", "connector": "sochen", "memory": ["money"] }
```

- `connector` says how to reach it (see Connectors).
- `memory` lists the slices of shared memory it may read. An assistant sees nothing else.
- Secrets never go in a flow file. A connector reads its key from an environment variable that the
  assistant names (`"keyEnv": "SOCHEN_API_KEY"`).

Every connector does one thing: take the request and the memory the assistant may see, and return
`{ text, data? }`. `data` is structured output (JSON) when the assistant gives any, so later steps can
use fields like `{{read.data.amount}}`.

## Steps

| Type | Does | Goes next |
|---|---|---|
| `agent` | asks an assistant; keeps its answer under the step's id | `next`, or the following step |
| `condition` | compares two values (`>`, `<`, `>=`, `<=`, `==`, `!=`, `contains`) | `then` or `else` |
| `approval` | saves the run and waits for a yes or no | yes: `next` or the following step; no: `onNo`, or the run ends as declined |
| `memory` | suggests a note to a slice of memory | `next`, or the following step |

`"end"` as a target finishes the run. Templates (`{{input}}`, `{{stepId.text}}`,
`{{stepId.data.field}}`) are filled from the run's input and earlier answers. A missing value fills in
as empty rather than failing, and a run stops after 100 steps so a loop can't spin forever.

Conditions are parsed, never evaluated as code: a flow can't run JavaScript.

## Memory

Notes are short pieces of text in named slices (`money`, `calendar`, `health`, ...). An assistant reads
only the slices it lists. A `memory` step, or anything an assistant learns, goes in as a **suggestion**;
only a person makes it part of the memory (`huddle memory keep <id>`). One assistant's guess never
quietly becomes something every other assistant believes.

## Runs

A run's state is one of `running`, `waiting` (on an approval), `done`, `declined` or `failed`. Each step
writes a log line with what went in and what came out. Approvals have their own ids, so a phone, a chat
message or the command line can answer them.

## Connectors

| Connector | How it's reached |
|---|---|
| `mock` | answers from a fixed list in the flow file; for building and testing |
| `http` | `POST url` with `{ ask, memory }`, expecting `{ text, data? }` back |
| `a2a` | A2A 1.0 JSON-RPC: the endpoint comes from the agent's card (`/.well-known/agent-card.json`), or is the url itself; `SendMessage`, then `GetTask` until the task completes, fails, or needs input or auth. A task that needs something comes back with that `state` for a flow to branch on |
| `openclaw`, `hermes` | `a2a` with their usual local address (`127.0.0.1:18789`, `127.0.0.1:9900`) and token variable (`OPENCLAW_A2A_TOKEN`, `HERMES_A2A_TOKEN`) filled in |
| `openai` | `POST <url>/v1/chat/completions` (or the full chat URL), memory as a system note; a plain reply with no task to follow |
| `sochen` | Sochen's Agent API (`POST https://sochen.dev/api/v1/run`), with a key from the environment |
| `homeassistant` | `POST <url>/api/conversation/process` with a long-lived token (`HASS_TOKEN`); no memory sent, since Assist matches plain commands; an "error" answer stops the flow |
| `agentzero` | `POST <url>/api_message` with `X-API-KEY` (`AGENT_ZERO_API_KEY`); a synchronous `{ context_id, response }` |
| `mcp` | next |

## Triggers

A flow's `trigger` says how its runs start:

| Trigger | Starts a run |
|---|---|
| `{ "type": "manual" }` | when you press Run (the default) |
| `{ "type": "schedule", "every": "2h", "input": "..." }` | every `m`inutes, `h`ours or `d`ays, counted from when the server starts or the flow is saved; skipped while the flow's last run is still going or waiting on you |
| `{ "type": "webhook" }` | when something posts to the flow's secret address; a text body, or JSON's `input` (else the whole JSON), is the run's input |

Missed schedules while Huddle was off aren't made up. A run that was mid-step when Huddle stopped is
marked failed on the next start, since the call to its assistant is gone; runs waiting on an approval
carry on as before.

## The server

One process serves the canvas, the API it uses (`/api`, described in
`packages/server/src/api-types.ts`), webhooks (`/hooks`), and Huddle's own A2A endpoint (`/a2a`). Runs
started from the API carry on in the background; the canvas follows them over a Server-Sent Events
stream of changes. With `HUDDLE_TOKEN` set, every call needs it, and the server refuses to listen
beyond this machine without one.

Over A2A, a task is a run. `SendMessage` starts the flow named in the message's metadata (or the only
one) and waits until the run ends or stops for an approval. The task's state follows the run: `running`
and `waiting` are working, `done` is completed (the run's last answer is the artifact), `declined` is
rejected, `failed` is failed. Only runs started over A2A can be read with `GetTask`.

"Describe it" asks an OpenAI-compatible model for a flow, checks it like any other, and gives the model
one more go with the problems listed. The draft only goes onto the canvas; nothing runs until you save
it and press Run.

## Not yet

Approvals on a phone, email and Telegram triggers, an MCP connector, and the hosted version. See the
README's roadmap.
