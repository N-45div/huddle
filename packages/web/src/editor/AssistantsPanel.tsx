import { type ReactNode, useEffect, useState } from "react";
import { api, describeError } from "../api.ts";
import { ChipsInput } from "../components/ChipsInput.tsx";
import { ConfirmDialog } from "../components/Dialog.tsx";
import { ErrorNote, Hint, Icon, Loading } from "../components/bits.tsx";
import { plural } from "../format.ts";
import type { Resource } from "../hooks.ts";
import { type Assistant, type ConnectorField, type ConnectorId, type ConnectorInfo, ENV_PATTERN, ID_PATTERN } from "../types.ts";

interface Props {
  readonly assistants: readonly Assistant[];
  readonly connectors: Resource<ConnectorInfo[]>;
  /** How many agent steps ask each assistant (by id). */
  readonly usage: ReadonlyMap<string, number>;
  /** Every slice named in the flow, offered when typing. */
  readonly slices: readonly string[];
  /** `renamed` is set when an assistant's id changed, so its steps can follow. */
  readonly onChange: (assistants: Assistant[], renamed?: { readonly from: string; readonly to: string }) => void;
  /** Replaces the opening line. */
  readonly note?: ReactNode;
  /** Replaces "asked in N steps" on each card. */
  readonly useLine?: (assistant: Assistant) => string;
  /** Your assistants (from the Assistants page), offered to add as they are. */
  readonly library?: readonly Assistant[];
  /** Shown when the list is empty. */
  readonly emptyHint?: string;
}

type Editing = { readonly mode: "add" } | { readonly mode: "edit"; readonly index: number };

export function AssistantsPanel({ assistants, connectors, usage, slices, onChange, note, useLine, library, emptyHint }: Props) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [removing, setRemoving] = useState<Assistant | null>(null);
  const [pick, setPick] = useState("");
  const taken = new Set(assistants.map((assistant) => assistant.id));
  const available = (library ?? []).filter((assistant) => !taken.has(assistant.id));

  const connectorName = (id: string) => connectors.data?.find((connector) => connector.id === id)?.name ?? id;

  if (editing) {
    const original = editing.mode === "edit" ? assistants[editing.index] : undefined;
    return (
      <AssistantForm
        original={original}
        connectors={connectors}
        takenIds={new Set(assistants.filter((assistant) => assistant !== original).map((assistant) => assistant.id))}
        slices={slices}
        onCancel={() => setEditing(null)}
        onSave={(assistant) => {
          if (editing.mode === "add") onChange([...assistants, assistant]);
          else {
            const next = assistants.map((other, index) => (index === editing.index ? assistant : other));
            onChange(next, original && original.id !== assistant.id ? { from: original.id, to: assistant.id } : undefined);
          }
          setEditing(null);
        }}
      />
    );
  }

  return (
    <div className="inspector-section">
      {note ?? <Hint>Each assistant is reached through a connector, and only reads the memory slices you give it.</Hint>}
      {assistants.length === 0 ? (
        <div className="empty empty-small">
          <p className="empty-title">No assistants yet.</p>
          <p className="hint">{emptyHint ?? "Add the assistants this flow hands work to."}</p>
        </div>
      ) : (
        <ul className="assistant-list">
          {assistants.map((assistant, index) => {
            const used = usage.get(assistant.id) ?? 0;
            return (
              <li key={assistant.id} className="card assistant-card">
                <div className="assistant-head">
                  <div>
                    <p className="assistant-name">{assistant.name || assistant.id}</p>
                    <p className="hint">
                      <code>{assistant.id}</code> · {connectorName(assistant.connector)} · {useLine ? useLine(assistant) : used ? `asked in ${plural(used, "step")}` : "not used yet"}
                    </p>
                    {assistant.description && <p className="assistant-description">{assistant.description}</p>}
                  </div>
                  <div className="assistant-actions">
                    <button type="button" className="btn btn-sm" onClick={() => setEditing({ mode: "edit", index })} aria-label={`Edit ${assistant.name || assistant.id}`}>
                      Edit
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost danger-text" onClick={() => setRemoving(assistant)} aria-label={`Remove ${assistant.name || assistant.id}`}>
                      Remove
                    </button>
                  </div>
                </div>
                <div className="chip-row" aria-label="Memory it reads">
                  {assistant.memory.length ? (
                    assistant.memory.map((slice) => (
                      <span key={slice} className="chip chip-static">
                        {slice}
                      </span>
                    ))
                  ) : (
                    <span className="hint">Reads no memory</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {available.length > 0 && (
        <div className="field library-pick">
          <label htmlFor="assistant-library">Add one of your assistants</label>
          <div className="copy-row">
            <select id="assistant-library" value={pick} onChange={(event) => setPick(event.target.value)}>
              <option value="">Choose one…</option>
              {available.map((assistant) => (
                <option key={assistant.id} value={assistant.id}>
                  {assistant.name ? `${assistant.name} (${assistant.id})` : assistant.id}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!pick}
              onClick={() => {
                const chosen = available.find((assistant) => assistant.id === pick);
                if (chosen) onChange([...assistants, chosen]);
                setPick("");
              }}
            >
              Add
            </button>
          </div>
        </div>
      )}
      <button type="button" className="btn" onClick={() => setEditing({ mode: "add" })}>
        <Icon name="plus" /> {available.length > 0 ? "Set up a new one" : "Add assistant"}
      </button>

      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.name || removing?.id || "this assistant"}?`}
        confirmLabel="Remove"
        danger
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) onChange(assistants.filter((assistant) => assistant !== removing));
          setRemoving(null);
        }}
      >
        {removing && (usage.get(removing.id) ?? 0) > 0 ? (
          <p>{plural(usage.get(removing.id) ?? 0, "step")} ask this assistant. They'll need another one before the flow can be saved.</p>
        ) : (
          <p>No step asks it, so nothing else changes.</p>
        )}
      </ConfirmDialog>
    </div>
  );
}

interface Draft {
  id: string;
  name: string;
  description: string;
  connector: string;
  memory: string[];
  url: string;
  keyEnv: string;
  model: string;
  agentId: string;
  audience: string;
  /** A command line, split into the command's parts on save. */
  command: string;
  /** PACT scope ids, split on spaces or commas on save. */
  scopes: string;
  replies: { key: string; answer: string }[];
}

type DraftErrors = Partial<Record<"id" | "connector" | "url" | "keyEnv" | "model" | "agentId" | "audience" | "command" | "replies" | "scopes", string>>;

/** A command line's parts: split on spaces, with "double" or 'single' quotes keeping spaces in; null if a quote isn't closed. */
function splitCommand(line: string): string[] | null {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (const char of line.trim()) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started || current) parts.push(current);
      current = "";
      started = false;
    } else {
      current += char;
    }
  }
  if (quote) return null;
  if (started || current) parts.push(current);
  return parts;
}

/** The parts back as one line, quoting any that need it. */
function joinCommand(parts: readonly string[] | undefined): string {
  return (parts ?? []).map((part) => (part === "" || /[\s"']/.test(part) ? (part.includes('"') ? `'${part}'` : `"${part}"`) : part)).join(" ");
}

function draftOf(assistant: Assistant | undefined): Draft {
  return {
    id: assistant?.id ?? "",
    name: assistant?.name ?? "",
    description: assistant?.description ?? "",
    connector: assistant?.connector ?? "",
    memory: [...(assistant?.memory ?? [])],
    url: assistant?.url ?? "",
    keyEnv: assistant?.keyEnv ?? "",
    model: assistant?.model ?? "",
    agentId: assistant?.agentId ?? "",
    audience: assistant?.audience ?? "",
    command: joinCommand(assistant?.command),
    scopes: (assistant?.scopes ?? []).join(" "),
    replies: Object.entries(assistant?.replies ?? {}).map(([key, answer]) => ({ key, answer })),
  };
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

function looksLikeUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function AssistantForm({
  original,
  connectors,
  takenIds,
  slices,
  onSave,
  onCancel,
}: {
  readonly original: Assistant | undefined;
  readonly connectors: Resource<ConnectorInfo[]>;
  readonly takenIds: ReadonlySet<string>;
  readonly slices: readonly string[];
  readonly onSave: (assistant: Assistant) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(original));
  const [idTouched, setIdTouched] = useState(original !== undefined);
  const [errors, setErrors] = useState<DraftErrors>({});

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const connector = connectors.data?.find((candidate) => candidate.id === draft.connector);
  const fields = connector?.fields ?? [];

  const validate = (): DraftErrors => {
    const found: DraftErrors = {};
    const id = draft.id.trim();
    if (!ID_PATTERN.test(id)) found.id = "Use letters, numbers, - and _ (up to 64), starting with a letter or number.";
    else if (takenIds.has(id)) found.id = `Another assistant in this flow is already called "${id}".`;
    if (!draft.connector) found.connector = "Pick how Huddle reaches it.";
    for (const field of fields) {
      if (field.key === "replies") {
        const filled = draft.replies.filter((reply) => reply.key.trim());
        if (field.required && filled.length === 0) found.replies = "Add at least one answer.";
        if (draft.replies.some((reply) => !reply.key.trim() && reply.answer.trim())) found.replies = "Each answer needs the words it answers to (or * for anything).";
        continue;
      }
      const value = draft[field.key].trim();
      if (field.required && !value) found[field.key] = `${field.label} is needed.`;
    }
    const url = draft.url.trim();
    if (fields.some((field) => field.key === "url") && url && !looksLikeUrl(url)) found.url = "That doesn't look like a web address. It should start with http:// or https://.";
    if (fields.some((field) => field.key === "command") && draft.command.trim() && splitCommand(draft.command) === null) found.command = "A quote isn't closed.";
    const keyEnv = draft.keyEnv.trim();
    if (fields.some((field) => field.key === "keyEnv") && keyEnv && !ENV_PATTERN.test(keyEnv)) found.keyEnv = "Use the variable's name in capitals, like SOCHEN_API_KEY. Never paste the key itself here.";
    return found;
  };

  const save = () => {
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) return;
    const shown = new Set(fields.map((field) => field.key));
    // Keep fields this form doesn't show, as long as the connector didn't change.
    const kept: Assistant | undefined = original && original.connector === draft.connector ? original : undefined;
    const assistant: Assistant = { id: draft.id.trim(), connector: draft.connector as ConnectorId, memory: draft.memory };
    const name = draft.name.trim();
    if (name) assistant.name = name;
    const description = draft.description.trim();
    if (description) assistant.description = description.slice(0, 500);
    for (const key of ["url", "keyEnv", "model", "agentId", "audience"] as const) {
      const value = shown.has(key) ? draft[key].trim() : (kept?.[key] ?? "");
      if (value) assistant[key] = value;
    }
    const command = shown.has("command") ? splitCommand(draft.command) : kept?.command;
    if (command?.length) assistant.command = command;
    const scopes = shown.has("scopes") ? draft.scopes.split(/[\s,]+/).filter(Boolean) : kept?.scopes;
    if (scopes?.length) assistant.scopes = scopes;
    if (shown.has("replies")) {
      const replies = Object.fromEntries(draft.replies.filter((reply) => reply.key.trim()).map((reply) => [reply.key.trim(), reply.answer]));
      if (Object.keys(replies).length) assistant.replies = replies;
    } else if (kept?.replies) {
      assistant.replies = kept.replies;
    }
    onSave(assistant);
  };

  const connectorOptions = connectors.data ?? [];
  const unknownConnector = draft.connector && !connectorOptions.some((candidate) => candidate.id === draft.connector);

  return (
    <form
      className="inspector-section assistant-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <p className="eyebrow">{original ? "Edit assistant" : "Add an assistant"}</p>

      <div className="field">
        <label htmlFor="assistant-name">Name</label>
        <input
          id="assistant-name"
          value={draft.name}
          autoComplete="off"
          onChange={(event) => {
            const name = event.target.value;
            setDraft((current) => ({ ...current, name, id: idTouched ? current.id : slug(name) }));
          }}
        />
      </div>

      <div className="field">
        <label htmlFor="assistant-description">What it's good at (optional)</label>
        <textarea id="assistant-description" rows={2} maxLength={500} value={draft.description} aria-describedby="assistant-description-hint" onChange={(event) => set("description", event.target.value)} />
        <Hint id="assistant-description-hint">One sentence, like "My work: meetings, calendar and docs". The router reads it when it picks an assistant for you.</Hint>
      </div>

      <div className="field">
        <label htmlFor="assistant-id">Id</label>
        <input
          id="assistant-id"
          className="mono"
          value={draft.id}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={errors.id ? true : undefined}
          aria-describedby="assistant-id-hint"
          onChange={(event) => {
            setIdTouched(true);
            set("id", event.target.value);
          }}
        />
        {errors.id ? (
          <p className="error-text" id="assistant-id-hint">
            {errors.id}
          </p>
        ) : (
          <Hint id="assistant-id-hint">Steps name the assistant they ask by this.</Hint>
        )}
      </div>

      <div className="field">
        <label htmlFor="assistant-connector">Connector</label>
        {connectors.loading && !connectors.data ? (
          <Loading label="Loading connectors…" />
        ) : (
          <select id="assistant-connector" value={draft.connector} aria-invalid={errors.connector ? true : undefined} onChange={(event) => set("connector", event.target.value)}>
            <option value="" disabled>
              How does Huddle reach it?
            </option>
            {unknownConnector && <option value={draft.connector}>{draft.connector}</option>}
            {connectorOptions.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        )}
        {connectors.error && <ErrorNote message={`Couldn't load the connectors. ${connectors.error}`} onRetry={() => void connectors.reload()} />}
        {errors.connector && <p className="error-text">{errors.connector}</p>}
        {connector && <Hint>{connector.description}</Hint>}
      </div>

      {fields.map((field) => (
        <ConnectorFieldInput key={field.key} field={field} draft={draft} error={errors[field.key]} onChange={set} />
      ))}

      <div className="field">
        <label htmlFor="assistant-memory">Memory it may read</label>
        <ChipsInput id="assistant-memory" values={draft.memory} onChange={(memory) => set("memory", memory)} suggestions={slices} describedBy="assistant-memory-hint" />
        <Hint id="assistant-memory-hint">Slices of shared memory, separated by commas. It sees kept notes in these and nothing else.</Hint>
      </div>

      <div className="form-foot">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary">
          {original ? "Done" : "Add assistant"}
        </button>
      </div>
      {Object.keys(errors).length > 0 && (
        <p className="error-text" role="alert">
          Some fields above need a look.
        </p>
      )}
    </form>
  );
}

function ConnectorFieldInput({
  field,
  draft,
  error,
  onChange,
}: {
  readonly field: ConnectorField;
  readonly draft: Draft;
  readonly error: string | undefined;
  readonly onChange: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
}) {
  const id = `assistant-${field.key}`;
  const hintId = `${id}-hint`;
  const label = `${field.label}${field.required ? "" : " (optional)"}`;

  if (field.key === "replies") {
    const rows = draft.replies;
    const update = (index: number, patch: Partial<Draft["replies"][number]>) => onChange("replies", rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
    return (
      <fieldset className="field replies">
        <legend>{field.required ? "Fixed answers" : "Fixed answers (optional)"}</legend>
        <Hint id={hintId}>The first answer whose words appear in the request wins; * answers anything else.</Hint>
        {rows.map((row, index) => (
          <div className="reply-row" key={index}>
            <input aria-label={`When the request contains (answer ${index + 1})`} className="mono" value={row.key} onChange={(event) => update(index, { key: event.target.value })} />
            <textarea aria-label={`Answer ${index + 1}`} rows={2} value={row.answer} onChange={(event) => update(index, { answer: event.target.value })} />
            <button type="button" className="icon-btn" aria-label={`Remove answer ${index + 1}`} onClick={() => onChange("replies", rows.filter((_, at) => at !== index))}>
              <Icon name="close" />
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-sm" onClick={() => onChange("replies", [...rows, { key: rows.length ? "" : "*", answer: "" }])}>
          <Icon name="plus" /> Add an answer
        </button>
        {error && <p className="error-text">{error}</p>}
      </fieldset>
    );
  }

  if (field.suggest === "models") return <ModelField field={field} draft={draft} error={error} onChange={onChange} />;

  const key = field.key;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className={key === "keyEnv" || key === "command" || key === "scopes" ? "mono" : undefined}
        value={draft[key]}
        placeholder={field.placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={hintId}
        onChange={(event) => onChange(key, event.target.value)}
      />
      {error ? (
        <p className="error-text" id={hintId}>
          {error}
        </p>
      ) : key === "keyEnv" ? (
        <Hint id={hintId}>The NAME of an environment variable on the server that holds the key, never the key itself. Set the variable where Huddle runs.</Hint>
      ) : (
        <span id={hintId} hidden />
      )}
    </div>
  );
}

/** A model name, with the ones the server can see at this assistant's address offered as you type. */
function ModelField({
  field,
  draft,
  error,
  onChange,
}: {
  readonly field: ConnectorField;
  readonly draft: Draft;
  readonly error: string | undefined;
  readonly onChange: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
}) {
  const id = `assistant-${field.key}`;
  const [found, setFound] = useState<{ readonly models: readonly string[]; readonly problem: string | null; readonly looking: boolean }>({ models: [], problem: null, looking: true });
  const url = draft.url.trim();

  useEffect(() => {
    let current = true;
    setFound((previous) => ({ ...previous, looking: true }));
    // Wait for typing to pause before asking the address.
    const timer = window.setTimeout(() => {
      api.models(draft.connector, url).then(
        ({ models }) => current && setFound({ models, problem: null, looking: false }),
        (failure: unknown) => current && setFound({ models: [], problem: describeError(failure), looking: false }),
      );
    }, 400);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [draft.connector, url]);

  const note = found.looking
    ? "Looking for its models…"
    : found.problem
      ? `${found.problem} You can still type a model's name.`
      : found.models.length === 0
        ? "It has no models yet. Pull one first, for example: ollama pull qwen3"
        : `It has ${plural(found.models.length, "model")}. Type to pick one.`;

  return (
    <div className="field">
      <label htmlFor={id}>{field.required ? field.label : `${field.label} (optional)`}</label>
      <input
        id={id}
        list={`${id}-choices`}
        value={draft.model}
        placeholder={field.placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange("model", event.target.value)}
      />
      <datalist id={`${id}-choices`}>
        {found.models.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>
      {error ? (
        <p className="error-text" id={`${id}-hint`}>
          {error}
        </p>
      ) : (
        <Hint id={`${id}-hint`}>{note}</Hint>
      )}
    </div>
  );
}
