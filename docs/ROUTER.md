# The router

One way in to every assistant you run, the way OpenRouter is one way in to every model. Any app or
SDK that speaks OpenAI reaches any of your assistants with one key; the model name is the assistant.
What OpenRouter doesn't have sits in the middle of every call: your shared memory (only the slices that
assistant may read), your approvals, and a record of what happened.

```
 any OpenAI client, app, script            another agent (A2A)          an MCP host (later)
            │ POST /v1/chat/completions              │                           │
            ▼                                        ▼                           ▼
 ┌────────────────────────────── Router API (server/src/router.ts) ─────────────────────────────┐
 │ auth: HUDDLE_ROUTER_KEY or HUDDLE_TOKEN · OpenAI request/response shapes · streaming           │
 └──────────────────────────────────────────────┬────────────────────────────────────────────────┘
                                                ▼
 ┌──────────────────────────────────── Router (core/src/router.ts) ──────────────────────────────┐
 │ 1. Candidates   model: "hermes"          → [hermes]                                           │
 │                 models: ["a", "b"]       → [a, b]           (fallbacks, in order)             │
 │                 model: "auto"            → Judge ranks your assistants for this request       │
 │ 2. Judge        Jev (calibrated Choice over the assistants' descriptions)                      │
 │    (core/src/judge.ts)  or an OpenAI-compatible model, or none (your list's order)             │
 │ 3. Try in order: each attempt is a one-step run through the Engine; first success answers.     │
 └──────────────────────────────────────────────┬────────────────────────────────────────────────┘
                                                ▼
                     Engine: memory slices · connector · run log (shows in Runs)
                                                ▼
   OpenClaw · Hermes · Ollama · agents in OpenShell sandboxes · businesses over PACT · Sochen · A2A…
                                                ▼
                     Store: your assistants · runs and their logs · memory · settings
```

## Your assistants

One list, set up once (`GET`/`PUT /api/assistants`), kept in the store. Each has an `id` (the model
name), a connector and its settings, the memory slices it may read, and a `description`: what it's
good at, in a sentence. The description is what automatic routing reads; without one the router uses
the name and connector.

The canvas's **Assistants** page manages the list. A flow's Assistants tab offers the same list, so an
assistant is set up once and added to a flow in one step (the flow keeps its own copy, so a flow
exported as JSON still runs on its own).

The page also shows each assistant's calls through the router, failures and average time to answer
(`GET /api/router`, counted from the run log), a **Try it** box that sends a message through `/v1` the
way any app would and shows who answered and how "auto" judged, and the code to call it from
JavaScript, Python or curl.

## Choosing who answers

| Request | Candidates | Order |
|---|---|---|
| `model: "hermes"` | that one | |
| `model: "hermes", models: ["local"]` | hermes, then local | as given |
| `models: ["a", "b", "c"]` | those | as given (OpenRouter's fallback field) |
| `model: "auto"` | all your assistants, or those in `models` | the judge's ranking |

**The judge** turns a request into a ranking of candidates:

- **Jev** (TypeSafe AI's System One model, with `TYPESAFE_API_KEY`): one Choice question whose options
  are your assistants and whose criteria are their descriptions. It answers with a probability for
  every assistant and a confidence, in well under a second, for a fraction of a cent. Huddle asks it
  with your own key, as one ingredient of a routing decision; it is never resold as a service.
- **Any OpenAI-compatible model** (`HUDDLE_LLM_*`, the same one "describe it" uses): asked for the
  best assistant and a ranking. No calibrated probabilities.
- **None**: your list's order.

The router tries the ranking in order, at most three, skipping candidates the judge gave under 5%. If
the judge itself fails, it falls back to your list's order and says so. Every answer reports how it
was routed: the judge, its pick, the probabilities and the confidence (`huddle.route`).

## Each attempt

An attempt is a one-step flow run by the Engine: the assistant's connector, with the kept notes from
its memory slices, logged like any run (named `Router: <assistant>`). A failed attempt (unreachable,
rate-limited after retries, an error from the assistant) moves on to the next candidate; the answer
lists what was skipped and why (`huddle.skipped`). All failing is a 502 with every reason; asking for an
assistant that doesn't exist is a 404.

Conversations: chat clients send the whole history each time, so the router sends the assistant the
last thing you said, with the conversation before it when there is one.

## Spending less

Every hand-off's tokens and cost are kept (the `spend` table): the assistant's own counts where it
reports them (OpenAI-style `usage`, OpenRouter's `usage.cost`, Ollama's `prompt_eval_count` and
`eval_count`), else a guess at four characters a token, marked `estimated`. An assistant's `price`
(dollars per million tokens in, from the provider's cache, and out, plus per call) turns tokens into
dollars; stand-ins and Ollama on this machine are free, and anything else without a price is unknown.

**Cheaper picks.** With probabilities from the judge, the candidates within a share of the best fit
(`prefer`: "balanced" 60%, "cheapest" 25%, "quality" none) are ordered by expected cost, the rest follow in
the judge's order. Expected cost is the price on this ask with the assistant's usual answer length, else
the middle of its last calls' reported costs. An unknown cost counts as the middle of the known ones and
goes after any that cost the same, so a free assistant beats an unknown one. Without probabilities
(a model judge, or none) cost changes nothing. When the answer comes from a cheaper assistant than the
judge's first choice, the difference from that one's expected cost is kept as saved. The route (judge,
probabilities, estimates, what went first) is logged on the run as `routed`, for replaying later.

**Sticky conversations.** A request whose messages include an earlier assistant turn is a later turn of
the conversation named by its instructions and first message (and key). For ten minutes after the last
turn it goes back to the same assistant without a judge call, which also keeps that assistant's prompt
cache warm (Anthropic and OpenAI caches live minutes). If that assistant fails, the judge decides afresh.

**Answers given again.** `reuseMinutes` on an assistant lets the router answer the very same ask (spaces
and Unicode forms evened out) from its last answer. The key covers the assistant's setup and the kept
notes it may read, so a new note means a new answer. No run is made; the saving is kept. Exact matches
only: similarity caches can be poisoned and give wrong answers to near-misses, and a personal assistant
sees few true repeats, so it stays opt-in. `huddle: { reuse: false }` or `Cache-Control: no-cache` skips it.

**Budget.** `HUDDLE_BUDGET` ("20/month", "5/day") caps what hand-offs to priced assistants spend, flows and
router alike. Past 80%, "auto" switches to "cheapest". Once spent, priced assistants aren't asked: a flow's
step fails saying so, `/v1` answers 429 `budget_exceeded`, and free assistants carry on.

`GET /api/router` returns this period's spend, the budget, and what kept answers and cheaper picks saved,
with spend per assistant; the Assistants page shows them.

## Keys and trust

- `/v1` takes `HUDDLE_ROUTER_KEY` or `HUDDLE_TOKEN` as a Bearer key. With neither set Huddle only
  listens on this machine.
- Assistants' own keys stay in environment variables, as everywhere in Huddle; the router never sees
  them, and neither do the apps that call it.
- Memory reaches an assistant only from its slices, whoever calls.

## Next

1. Trust tiers: who may call which assistants; strangers' requests wait in Approvals.
2. Keys per app, each with its own budget and the assistants it may reach (one budget for all, done).
3. Each assistant as an MCP tool and at its own A2A address.
4. Learning from outcomes: which assistant answered well, fed back into routing.
