import { useRef, useState } from "react";
import { ApiFailure, api, describeError, type RouterReply } from "../api.ts";
import { useApp } from "../app-context.ts";
import { ErrorNote, Hint, Icon, Link, Loading } from "../components/bits.tsx";
import { TabPanel, Tabs } from "../components/Tabs.tsx";
import { AssistantsPanel } from "../editor/AssistantsPanel.tsx";
import { useChanges } from "../events.ts";
import { ago, plural } from "../format.ts";
import { useDebounced, useResource } from "../hooks.ts";
import { href } from "../router.ts";
import type { Assistant, Info, RouterUsage } from "../types.ts";

/**
 * Your assistants, set up once: flows add them from here, and the router reaches them by id through an
 * OpenAI-compatible API. This page manages the list, shows how each has done through the router, lets
 * you try a message, and gives the code to call it from anything else.
 */
export function AssistantsScreen() {
  const { info, authVersion } = useApp();
  const assistants = useResource(() => api.assistants(), [authVersion]);
  const connectors = useResource(() => api.connectors(), [authVersion]);
  const router = useResource(() => api.router(), [authVersion]);
  const kept = useResource(() => api.memory("kept"), [authVersion]);
  const [saveError, setSaveError] = useState<{ message: string; problems: readonly string[] } | null>(null);
  const refetch = useDebounced(() => {
    void assistants.reload();
    void router.reload();
  }, 200);

  useChanges((change) => {
    if (change.kind === "assistants" || change.kind === "resync") refetch();
    if (change.kind === "run") void router.reload();
  });

  const list = assistants.data ?? [];
  const usage = new Map((router.data?.usage ?? []).map((row) => [row.assistant, row]));
  const slices = [...new Set([...(kept.data ?? []).map((note) => note.slice), ...list.flatMap((assistant) => assistant.memory)])].sort();

  const save = async (next: Assistant[]) => {
    setSaveError(null);
    try {
      assistants.setData(await api.saveAssistants(next));
    } catch (error) {
      setSaveError({ message: describeError(error), problems: error instanceof ApiFailure ? error.problems : [] });
    }
  };

  return (
    <div className="page assistants-page">
      <header className="page-head">
        <div>
          <h1>Assistants</h1>
          <p className="lede">Set each assistant up once. Flows add them from here, and any app reaches them through one API, with only the memory each may read.</p>
        </div>
      </header>

      <div className="assistants-grid">
        <section className="assistants-list" aria-labelledby="your-assistants">
          <h2 id="your-assistants">Your assistants</h2>
          {assistants.error && <ErrorNote message={assistants.error} onRetry={() => void assistants.reload()} />}
          {saveError && <ErrorNote message={saveError.message} problems={saveError.problems} />}
          {assistants.loading && !assistants.data ? (
            <Loading label="Loading your assistants…" />
          ) : (
            <AssistantsPanel
              assistants={list}
              connectors={connectors}
              usage={new Map()}
              slices={slices}
              onChange={(next) => void save(next)}
              note={<Hint>Each one is reached through its connector and reads only the memory slices you give it. Its id is its model name in the router.</Hint>}
              emptyHint="Add the assistants you use: OpenClaw, Hermes, a local model, a sandboxed agent…"
              useLine={(assistant) => usageLine(usage.get(assistant.id))}
            />
          )}
        </section>

        <aside className="router-side">
          <TryIt assistants={list} />
          {router.data && <UseFromCode baseUrl={router.data.baseUrl} judge={router.data.judge} keyRequired={router.data.keyRequired} ids={list.map((assistant) => assistant.id)} mcp={info?.mcp ?? null} />}
        </aside>
      </div>
    </div>
  );
}

function usageLine(row: RouterUsage | undefined): string {
  if (!row) return "not called through the router yet";
  const parts = [plural(row.calls, "call")];
  if (row.failures) parts.push(`${row.failures} failed`);
  if (row.averageMs !== null) parts.push(`answers in ${seconds(row.averageMs)}`);
  if (row.lastAt) parts.push(`last ${ago(row.lastAt)}`);
  return parts.join(" · ");
}

const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`);

const JUDGES: Readonly<Record<string, string>> = {
  jev: "Jev picked",
  model: "Your judging model picked",
  order: "No judge is set up, so your list's order",
  test: "The test judge picked",
};

function TryIt({ assistants }: { readonly assistants: readonly Assistant[] }) {
  const [model, setModel] = useState("auto");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<RouterReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(0);
  const [took, setTook] = useState<number | null>(null);
  const name = (id: string) => assistants.find((assistant) => assistant.id === id)?.name ?? id;

  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    setReply(null);
    started.current = Date.now();
    try {
      setReply(await api.chat(model, text.trim()));
      setTook(Date.now() - started.current);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card try-it" aria-labelledby="try-it-title">
      <h2 id="try-it-title">Try it</h2>
      {assistants.length === 0 ? (
        <p className="hint">Add an assistant first; then send it a message from here.</p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <div className="field">
            <label htmlFor="try-model">Ask</label>
            <select id="try-model" value={model} onChange={(event) => setModel(event.target.value)}>
              <option value="auto">Auto: let Huddle pick</option>
              {assistants.map((assistant) => (
                <option key={assistant.id} value={assistant.id}>
                  {assistant.name ? `${assistant.name} (${assistant.id})` : assistant.id}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="try-text">Message</label>
            <textarea
              id="try-text"
              rows={3}
              value={text}
              placeholder="What's my cat called?"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send();
              }}
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()}>
            {busy ? "Asking…" : "Send"}
          </button>
        </form>
      )}
      {error && <ErrorNote message={error} />}
      {reply && (
        <div className="try-reply" role="status">
          <p className="eyebrow">
            {name(reply.model)} answered{took !== null ? ` in ${seconds(took)}` : ""}
          </p>
          <p className="try-answer">{reply.text}</p>
          {reply.route && (
            <div className="route">
              <p className="hint">
                {JUDGES[reply.route.judge] ?? `${reply.route.judge} picked`}
                {reply.route.confidence !== null ? `, ${Math.round(reply.route.confidence * 100)}% sure` : ""}
                {reply.route.model ? ` (${reply.route.model})` : ""}.
              </p>
              {reply.route.probabilities && (
                <ul className="route-bars" aria-label="How likely each assistant fits">
                  {Object.entries(reply.route.probabilities)
                    .sort((a, b) => b[1] - a[1])
                    .map(([id, p]) => (
                      <li key={id}>
                        <span className="route-name">{name(id)}</span>
                        <span className="route-bar" aria-hidden="true">
                          <span style={{ width: `${Math.max(2, Math.round(p * 100))}%` }} />
                        </span>
                        <span className="route-p">{Math.round(p * 100)}%</span>
                      </li>
                    ))}
                </ul>
              )}
              {!reply.route.probabilities && reply.route.order.length > 1 && <p className="hint">Order it would try: {reply.route.order.map(name).join(", then ")}.</p>}
              {reply.route.note && <p className="hint">{reply.route.note}</p>}
            </div>
          )}
          {reply.skipped.map((skip) => (
            <p key={skip.id} className="hint">
              Skipped {name(skip.id)}: {skip.error}
            </p>
          ))}
          {reply.runId && (
            <Link to={href.run(reply.runId)} className="btn btn-sm btn-ghost">
              See the run
            </Link>
          )}
        </div>
      )}
    </section>
  );
}

type Lang = "curl" | "js" | "python" | "mcp";

function UseFromCode({ baseUrl, judge, keyRequired, ids, mcp }: { readonly baseUrl: string; readonly judge: string | null; readonly keyRequired: boolean; readonly ids: readonly string[]; readonly mcp: Info["mcp"] | null }) {
  const [lang, setLang] = useState<Lang>("js");
  const model = ids[0] ?? "auto";
  const key = keyRequired ? "$HUDDLE_ROUTER_KEY" : "local";
  const code: Record<Exclude<Lang, "mcp">, string> = {
    curl: `curl ${baseUrl}/chat/completions \\\n  -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" \\\n  -d '{"model": "auto", "messages": [{"role": "user", "content": "What's my cat called?"}]}'`,
    js: `import OpenAI from "openai";\n\nconst huddle = new OpenAI({ baseURL: "${baseUrl}", apiKey: ${keyRequired ? "process.env.HUDDLE_ROUTER_KEY" : '"local"'} });\n\nconst reply = await huddle.chat.completions.create({\n  model: "auto", // or "${model}", or models: ["${model}", ...] for fallbacks\n  messages: [{ role: "user", content: "What's my cat called?" }],\n});\nconsole.log(reply.model, reply.choices[0].message.content);`,
    python: `from openai import OpenAI\nimport os\n\nhuddle = OpenAI(base_url="${baseUrl}", api_key=${keyRequired ? 'os.environ["HUDDLE_ROUTER_KEY"]' : '"local"'})\n\nreply = huddle.chat.completions.create(\n    model="auto",  # or "${model}"\n    messages=[{"role": "user", "content": "What's my cat called?"}],\n)\nprint(reply.model, reply.choices[0].message.content)`,
  };

  return (
    <section className="card use-from-code" aria-labelledby="use-from-code-title">
      <h2 id="use-from-code-title">Use it from any app</h2>
      {lang === "mcp" ? (
        <p className="hint">
          Claude Code, Claude Desktop, Cursor and other MCP clients get a tool for each flow, <code>get_run</code> to follow one, and <code>ask_assistant</code> for
          these assistants. Approvals still come to you in Huddle.{" "}
          {mcp?.token ? `Send ${mcp.token} to act as you, or give someone their own token from Contacts: they see only the flows they may start.` : "No token is needed on this machine."}
        </p>
      ) : (
        <p className="hint">
          OpenAI-compatible: the model is an assistant's id, or <code>auto</code>.{" "}
          {judge === "jev" ? "Jev picks for auto." : judge === "model" ? "Your judging model (HUDDLE_LLM_MODEL) picks for auto; set TYPESAFE_API_KEY to have Jev pick." : "Set TYPESAFE_API_KEY to have Jev pick for auto; until then it's your list's order."}{" "}
          {keyRequired ? "Send your Huddle token or HUDDLE_ROUTER_KEY as the key." : "No key is needed on this machine."}
        </p>
      )}
      <Tabs
        idPrefix="code"
        label="Language"
        value={lang}
        onChange={setLang}
        tabs={[
          { id: "js", label: "JavaScript" },
          { id: "python", label: "Python" },
          { id: "curl", label: "curl" },
          ...(mcp ? [{ id: "mcp" as const, label: "MCP" }] : []),
        ]}
      />
      <TabPanel idPrefix="code" id={lang} className="tab-panel">
        {lang === "mcp" && mcp ? <McpSetup mcp={mcp} /> : <Snippet code={code[lang === "mcp" ? "js" : lang]} />}
      </TabPanel>
      {lang === "mcp" && mcp ? (
        <p className="hint">
          MCP address <code>{mcp.url}</code>
        </p>
      ) : (
        <p className="hint">
          Base URL <code>{baseUrl}</code>
        </p>
      )}
    </section>
  );
}

/** Adding Huddle to Claude Code, and to Claude Desktop or Cursor (through mcp-remote, which sends the token). */
function McpSetup({ mcp }: { readonly mcp: Info["mcp"] }) {
  const claude = `claude mcp add --transport http huddle ${mcp.url}${mcp.token ? ` \\\n  --header "Authorization: Bearer $${mcp.token}"` : ""}`;
  // mcp-remote reads ${HUDDLE_AUTH} itself: a space inside args breaks npx on Windows, so the token goes in env.
  const args = ["-y", "mcp-remote", mcp.url, ...(mcp.token ? ["--header", "Authorization:${HUDDLE_AUTH}"] : [])];
  const fields = [`"command": "npx"`, `"args": [${args.map((arg) => JSON.stringify(arg)).join(", ")}]`, ...(mcp.token ? [`"env": { "HUDDLE_AUTH": "Bearer <your ${mcp.token}>" }`] : [])];
  const desktop = `{\n  "mcpServers": {\n    "huddle": {\n      ${fields.join(",\n      ")}\n    }\n  }\n}`;
  return (
    <>
      <p className="eyebrow">Claude Code</p>
      <Snippet code={claude} />
      <p className="eyebrow">Claude Desktop, Cursor</p>
      <Snippet code={desktop} />
      <p className="hint">
        In <code>claude_desktop_config.json</code> or <code>.cursor/mcp.json</code>. Cursor can also take the address and an <code>Authorization</code> header
        directly, as <code>url</code> and <code>headers</code>.
      </p>
    </>
  );
}

/** A block of code with a Copy button. */
function Snippet({ code }: { readonly code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <pre className="code-block">
        <code>{code}</code>
      </pre>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          void navigator.clipboard?.writeText(code).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          });
        }}
      >
        <Icon name="copy" /> {copied ? "Copied" : "Copy"}
      </button>
    </>
  );
}
