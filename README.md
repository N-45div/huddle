# Huddle

**n8n for personal assistants.** Connect the AI assistants you already use, give them one shared
memory, and draw how they hand work to each other, with you approving anything that matters.

> Status: early. The flow engine, shared memory, approvals and the first connectors run today from the
> command line. The canvas and the hosted version are being built. See [Roadmap](#roadmap).

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
| **Sochen** | Sochen's agent and its pets, through the Agent API | works |
| **HTTP** | anything with a simple request/response API | works |
| **Mock** | a stand-in assistant for building and testing flows | works |
| **A2A** | any agent that speaks the open Agent2Agent protocol | next |
| **MCP** | assistants and tools exposed as Model Context Protocol servers | next |
| **OpenClaw** | the open-source personal assistant | next |

Assistants that offer no way in from outside (some consumer apps don't) can't be connected yet. Where
an assistant can be reached by email or a messaging channel, that's on the roadmap.

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
2. A2A, MCP and OpenClaw connectors
3. The canvas: drag assistants in, draw the hand-offs, watch runs live
4. Triggers: schedules, webhooks, email and Telegram, with approvals on your phone
5. "Describe it": write the flow in a sentence and Huddle draws it
6. One-command self-hosting with Docker, then the hosted version

## License

[AGPL-3.0](LICENSE). You can use, change and self-host Huddle freely. If you run a changed version as a
service for others, you share your changes under the same license.
