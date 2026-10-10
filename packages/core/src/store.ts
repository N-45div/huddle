import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import type { Spend } from "./cost.ts";
import { findSecret, redactSecrets, SensitiveNote } from "./memory/sensitive.ts";
import type { Assistant, ContactTier, Flow } from "./schema.ts";
import type { RunContext } from "./template.ts";

/**
 * Everything Huddle keeps, in one SQLite file (Node's built-in driver, so nothing to compile): runs
 * and where each one stands, approvals, shared memory, and a log line per step. A run waiting on an
 * approval is all here, so it carries on after a restart.
 */

export type RunState = "running" | "waiting" | "done" | "declined" | "failed";

export interface Run {
  readonly id: string;
  /** The saved flow it ran, when it was one. */
  readonly flowId: string | null;
  readonly flow: Flow;
  readonly state: RunState;
  /** The step the run is at (waiting) or stopped on (failed); null once done or declined. */
  readonly at: string | null;
  readonly context: RunContext;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Approval {
  readonly id: string;
  readonly runId: string;
  readonly stepId: string;
  readonly message: string;
  readonly status: "waiting" | "yes" | "no";
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

export interface Note {
  readonly id: string;
  readonly slice: string;
  readonly note: string;
  /** A suggestion until a person keeps it; only kept notes reach assistants. */
  readonly status: "suggested" | "kept";
  readonly source: string;
  readonly createdAt: string;
}

/** What went on hand-offs to one assistant over a period. */
export interface SpendTotal {
  readonly assistant: string;
  readonly calls: number;
  /** Dollars spent on the calls with a known cost. */
  readonly usd: number;
  /** Calls whose cost is unknown (no price given, none reported). */
  readonly unpriced: number;
  /** Calls whose tokens were guessed from the text's length. */
  readonly estimated: number;
  /** Router calls answered from a kept answer, and what they would have cost. */
  readonly reused: number;
  readonly savedByReuse: number;
  /** Router calls that went to a cheaper assistant than the judge's first choice, and what that saved. */
  readonly cheaper: number;
  readonly savedByCheaper: number;
}

/** An answer the router may give again. */
export interface KeptAnswer {
  readonly assistant: string;
  readonly runId: string;
  readonly text: string;
  readonly data: unknown;
  readonly costUsd: number | null;
}

export interface SavedFlow {
  readonly id: string;
  readonly flow: Flow;
  /** The secret part of the flow's webhook address. */
  readonly webhookSecret: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What changed, for anyone watching (the server streams these to the canvas). */
export type Change =
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "approval"; readonly runId: string }
  | { readonly kind: "memory" }
  | { readonly kind: "flow"; readonly flowId: string }
  /** What an OpenShell sandbox is asking for changed (the server watches the gateway). */
  | { readonly kind: "sandbox" }
  /** The list of your assistants changed. */
  | { readonly kind: "assistants" }
  | { readonly kind: "contacts" }
  | { readonly kind: "signin" };

/** Someone you know, who reaches Huddle with their own token, or by mailing a flow from one of their addresses. */
export interface Contact {
  readonly id: string;
  readonly name: string;
  readonly tier: ContactTier;
  /** Addresses that count as them. */
  readonly emails: readonly string[];
  readonly createdAt: string;
  /** When their token last reached Huddle. */
  readonly lastSeenAt: string | null;
}

export interface LogLine {
  readonly runId: string;
  readonly stepId: string;
  readonly kind: string;
  readonly detail: unknown;
  readonly at: string;
}

const newId = (prefix: string) => `${prefix}_${randomBytes(6).toString("hex")}`;
const now = () => new Date().toISOString();

type Row = Record<string, unknown>;

export class Store {
  readonly db: DatabaseSync;
  /** Emits "change" with a Change after every write. */
  readonly events = new EventEmitter();

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, flow TEXT NOT NULL, state TEXT NOT NULL, at TEXT, context TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS flows (id TEXT PRIMARY KEY, name TEXT NOT NULL, flow TEXT NOT NULL, webhook_secret TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT);
      CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, slice TEXT NOT NULL, note TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS log (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, step_id TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assistants (id TEXT PRIMARY KEY, position INTEGER NOT NULL, assistant TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, tier TEXT NOT NULL, emails TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_seen_at TEXT);
      CREATE TABLE IF NOT EXISTS spend (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, step_id TEXT NOT NULL, flow_id TEXT, flow_name TEXT NOT NULL, assistant TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cached_tokens INTEGER NOT NULL, cost_usd REAL, estimated INTEGER NOT NULL, saved_usd REAL, saved_by TEXT, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS answers (key TEXT PRIMARY KEY, assistant TEXT NOT NULL, run_id TEXT NOT NULL, text TEXT NOT NULL, data TEXT NOT NULL, cost_usd REAL, expires_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS spend_at ON spend (at);
      CREATE INDEX IF NOT EXISTS spend_assistant ON spend (assistant, seq);
      CREATE INDEX IF NOT EXISTS approvals_run ON approvals (run_id);
      CREATE INDEX IF NOT EXISTS notes_slice ON notes (slice, status);
      CREATE INDEX IF NOT EXISTS log_run ON log (run_id, seq);
    `);
    // Databases from before saved flows: add the column runs use to point at one.
    const columns = this.db.prepare("PRAGMA table_info(runs)").all() as Row[];
    if (!columns.some((column) => column.name === "flow_id")) this.db.exec("ALTER TABLE runs ADD COLUMN flow_id TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS runs_flow ON runs (flow_id, created_at)");
  }

  private changed(change: Change): void {
    this.events.emit("change", change);
  }

  // Flows ------------------------------------------------------------------------------------------

  /** Saves a flow: a new one when there's no id, else replaces that one (keeping its webhook secret). */
  saveFlow(flow: Flow, id?: string): SavedFlow {
    const existing = id ? this.flow(id) : null;
    if (id && !existing) throw new Error(`There's no flow ${id}.`);
    const saved: SavedFlow = {
      id: existing?.id ?? newId("flow"),
      flow,
      webhookSecret: existing?.webhookSecret ?? randomBytes(16).toString("hex"),
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    };
    if (existing) this.db.prepare("UPDATE flows SET name = ?, flow = ?, updated_at = ? WHERE id = ?").run(flow.name, JSON.stringify(flow), saved.updatedAt, saved.id);
    else this.db.prepare("INSERT INTO flows (id, name, flow, webhook_secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(saved.id, flow.name, JSON.stringify(flow), saved.webhookSecret, saved.createdAt, saved.updatedAt);
    this.changed({ kind: "flow", flowId: saved.id });
    return saved;
  }

  flow(id: string): SavedFlow | null {
    const row = this.db.prepare("SELECT * FROM flows WHERE id = ?").get(id) as Row | undefined;
    return row ? toFlow(row) : null;
  }

  flows(): SavedFlow[] {
    return (this.db.prepare("SELECT * FROM flows ORDER BY updated_at DESC").all() as Row[]).map(toFlow);
  }

  deleteFlow(id: string): boolean {
    const gone = Number(this.db.prepare("DELETE FROM flows WHERE id = ?").run(id).changes) === 1;
    if (gone) this.changed({ kind: "flow", flowId: id });
    return gone;
  }

  /** A new webhook secret for a flow, so an address that leaked stops working. */
  rotateWebhook(id: string): SavedFlow {
    const secret = randomBytes(16).toString("hex");
    if (Number(this.db.prepare("UPDATE flows SET webhook_secret = ? WHERE id = ?").run(secret, id).changes) !== 1) throw new Error(`There's no flow ${id}.`);
    return this.flow(id)!;
  }

  close(): void {
    this.db.close();
  }

  // Your assistants: set up once, reached by id through the router --------------------------------

  assistants(): Assistant[] {
    return (this.db.prepare("SELECT assistant FROM assistants ORDER BY position").all() as Row[]).map((row) => JSON.parse(String(row.assistant)) as Assistant);
  }

  assistant(id: string): Assistant | null {
    const row = this.db.prepare("SELECT assistant FROM assistants WHERE id = ?").get(id) as Row | undefined;
    return row ? (JSON.parse(String(row.assistant)) as Assistant) : null;
  }

  /** Replaces the whole list, in order (the caller has checked it). */
  saveAssistants(assistants: readonly Assistant[]): void {
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM assistants");
      const insert = this.db.prepare("INSERT INTO assistants (id, position, assistant, updated_at) VALUES (?, ?, ?, ?)");
      assistants.forEach((assistant, position) => insert.run(assistant.id, position, JSON.stringify(assistant), now()));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.changed({ kind: "assistants" });
  }

  // Contacts: people (and their agents) who may reach Huddle, each with a tier and their own token -----

  contacts(): Contact[] {
    return (this.db.prepare("SELECT * FROM contacts ORDER BY created_at").all() as Row[]).map(toContact);
  }

  contact(id: string): Contact | null {
    const row = this.db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as Row | undefined;
    return row ? toContact(row) : null;
  }

  /** Adds someone; their token is returned this once and only its hash is kept. */
  addContact(input: { readonly name: string; readonly tier: ContactTier; readonly emails?: readonly string[] }): { readonly contact: Contact; readonly token: string } {
    const id = newId("contact");
    const token = contactToken();
    this.db
      .prepare("INSERT INTO contacts (id, name, tier, emails, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, NULL)")
      .run(id, input.name, input.tier, JSON.stringify(cleanEmails(input.emails)), hashToken(token), now());
    this.changed({ kind: "contacts" });
    return { contact: this.contact(id)!, token };
  }

  updateContact(id: string, change: { readonly name?: string; readonly tier?: ContactTier; readonly emails?: readonly string[] }): Contact | null {
    const existing = this.contact(id);
    if (!existing) return null;
    this.db
      .prepare("UPDATE contacts SET name = ?, tier = ?, emails = ? WHERE id = ?")
      .run(change.name ?? existing.name, change.tier ?? existing.tier, JSON.stringify(change.emails ? cleanEmails(change.emails) : existing.emails), id);
    this.changed({ kind: "contacts" });
    return this.contact(id);
  }

  /** A new token for them; the old one stops working at once. */
  newContactToken(id: string): string | null {
    if (!this.contact(id)) return null;
    const token = contactToken();
    this.db.prepare("UPDATE contacts SET token_hash = ? WHERE id = ?").run(hashToken(token), id);
    this.changed({ kind: "contacts" });
    return token;
  }

  removeContact(id: string): boolean {
    const removed = Number(this.db.prepare("DELETE FROM contacts WHERE id = ?").run(id).changes) > 0;
    if (removed) this.changed({ kind: "contacts" });
    return removed;
  }

  /** The contact a token belongs to (noting that they were seen), or null. */
  contactByToken(token: string): Contact | null {
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const row = this.db.prepare("SELECT * FROM contacts WHERE token_hash = ?").get(hashToken(token)) as Row | undefined;
    if (!row) return null;
    this.db.prepare("UPDATE contacts SET last_seen_at = ? WHERE id = ?").run(now(), row.id as string);
    return toContact({ ...row, last_seen_at: now() });
  }

  /** The contact an email address belongs to, or null. */
  contactByEmail(email: string): Contact | null {
    const wanted = email.trim().toLowerCase();
    return this.contacts().find((contact) => contact.emails.includes(wanted)) ?? null;
  }

  // Settings: small things Huddle keeps about itself, like its PACT signing key ----------------------

  setting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as Row | undefined;
    return row ? String(row.value) : null;
  }

  saveSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  deleteSetting(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  /** The value for `key`, made with `make` and kept the first time it's asked for. */
  settingOr(key: string, make: () => string): string {
    const existing = this.setting(key);
    if (existing !== null) return existing;
    const value = make();
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(key, value);
    return this.setting(key) ?? value;
  }

  // Runs -------------------------------------------------------------------------------------------

  createRun(flow: Flow, input: string, flowId: string | null = null): Run {
    const run: Run = { id: newId("run"), flowId, flow, state: "running", at: null, context: { input, steps: {} }, error: null, createdAt: now(), updatedAt: now() };
    this.db
      .prepare("INSERT INTO runs (id, flow_id, flow, state, at, context, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(run.id, flowId, JSON.stringify(flow), run.state, run.at, JSON.stringify(run.context), run.error, run.createdAt, run.updatedAt);
    this.changed({ kind: "run", runId: run.id });
    return run;
  }

  saveRun(run: Pick<Run, "id" | "state" | "at" | "context" | "error">): void {
    this.db.prepare("UPDATE runs SET state = ?, at = ?, context = ?, error = ?, updated_at = ? WHERE id = ?").run(run.state, run.at, JSON.stringify(run.context), run.error, now(), run.id);
    this.changed({ kind: "run", runId: run.id });
  }

  /**
   * Runs that were mid-step when Huddle stopped can't pick up where they were (the call to the assistant
   * is gone), so on start they're marked failed. Runs waiting on an approval are untouched.
   */
  failInterrupted(): number {
    const ids = (this.db.prepare("SELECT id, at FROM runs WHERE state = 'running'").all() as Row[]).map((row) => ({ id: String(row.id), at: row.at === null ? null : String(row.at) }));
    for (const run of ids) {
      this.db.prepare("UPDATE runs SET state = 'failed', error = ?, updated_at = ? WHERE id = ?").run("Huddle stopped while this run was going; run it again.", now(), run.id);
      this.log(run.id, run.at ?? "", "failed", { error: "interrupted" });
      this.changed({ kind: "run", runId: run.id });
    }
    return ids.length;
  }

  run(id: string): Run | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
    return row ? toRun(row) : null;
  }

  runs(limit = 20, flowId?: string): Run[] {
    const rows = flowId
      ? this.db.prepare("SELECT * FROM runs WHERE flow_id = ? ORDER BY created_at DESC LIMIT ?").all(flowId, limit)
      : this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?").all(limit);
    return (rows as Row[]).map(toRun);
  }

  // Approvals --------------------------------------------------------------------------------------

  addApproval(runId: string, stepId: string, message: string): Approval {
    const approval: Approval = { id: newId("ok"), runId, stepId, message, status: "waiting", createdAt: now(), decidedAt: null };
    this.db.prepare("INSERT INTO approvals (id, run_id, step_id, message, status, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(approval.id, runId, stepId, message, approval.status, approval.createdAt);
    this.changed({ kind: "approval", runId });
    return approval;
  }

  /** Approvals still waiting on someone, oldest first. */
  waitingApprovals(): Approval[] {
    return (this.db.prepare("SELECT * FROM approvals WHERE status = 'waiting' ORDER BY created_at").all() as Row[]).map(toApproval);
  }

  approval(id: string): Approval | null {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Row | undefined;
    return row ? toApproval(row) : null;
  }

  /** The approval a run is waiting on, if any. */
  waitingApproval(runId: string): Approval | null {
    const row = this.db.prepare("SELECT * FROM approvals WHERE run_id = ? AND status = 'waiting' ORDER BY created_at DESC LIMIT 1").get(runId) as Row | undefined;
    return row ? toApproval(row) : null;
  }

  /** Records a decision once; false if it was already decided. */
  decide(id: string, yes: boolean): boolean {
    const result = this.db.prepare("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'waiting'").run(yes ? "yes" : "no", now(), id);
    const decided = Number(result.changes) === 1;
    if (decided) this.changed({ kind: "approval", runId: this.approval(id)?.runId ?? "" });
    return decided;
  }

  // Memory -----------------------------------------------------------------------------------------

  /** A suggestion from a flow or an assistant, with any password, card number, code or key masked. */
  suggest(slice: string, note: string, source: string): Note {
    return this.addNote(slice, redactSecrets(note), source, "suggested");
  }

  /** A note a person writes themselves: kept straight away. One holding a secret is refused (SensitiveNote). */
  remember(slice: string, note: string): Note {
    const secret = findSecret(note);
    if (secret) throw new SensitiveNote(secret);
    return this.addNote(slice, note, "you", "kept");
  }

  keep(id: string): boolean {
    // Suggestions are masked when made; this catches any from before that.
    const waiting = this.db.prepare("SELECT note FROM notes WHERE id = ? AND status = 'suggested'").get(id) as Row | undefined;
    const secret = waiting ? findSecret(String(waiting.note)) : null;
    if (secret) throw new SensitiveNote(secret, "kept");
    const kept = Number(this.db.prepare("UPDATE notes SET status = 'kept' WHERE id = ? AND status = 'suggested'").run(id).changes) === 1;
    if (kept) this.changed({ kind: "memory" });
    return kept;
  }

  forget(id: string): boolean {
    const gone = Number(this.db.prepare("DELETE FROM notes WHERE id = ?").run(id).changes) === 1;
    if (gone) this.changed({ kind: "memory" });
    return gone;
  }

  /** Kept notes in these slices: what an assistant allowed these slices may read. */
  keptNotes(slices: readonly string[]): Note[] {
    if (slices.length === 0) return [];
    const marks = slices.map(() => "?").join(", ");
    return (this.db.prepare(`SELECT * FROM notes WHERE status = 'kept' AND slice IN (${marks}) ORDER BY created_at`).all(...slices) as Row[]).map(toNote);
  }

  notes(status?: Note["status"]): Note[] {
    const rows = status
      ? (this.db.prepare("SELECT * FROM notes WHERE status = ? ORDER BY created_at").all(status) as Row[])
      : (this.db.prepare("SELECT * FROM notes ORDER BY created_at").all() as Row[]);
    return rows.map(toNote);
  }

  private addNote(slice: string, note: string, source: string, status: Note["status"]): Note {
    const row: Note = { id: newId("note"), slice, note, status, source, createdAt: now() };
    this.db.prepare("INSERT INTO notes (id, slice, note, status, source, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(row.id, slice, note, status, source, row.createdAt);
    this.changed({ kind: "memory" });
    return row;
  }

  // Spend: what each hand-off took, and what the router saved -----------------------------------------

  /** What one hand-off took. */
  addSpend(run: Pick<Run, "id" | "flowId" | "flow">, stepId: string, assistant: string, spend: Spend): void {
    this.db
      .prepare("INSERT INTO spend (run_id, step_id, flow_id, flow_name, assistant, input_tokens, output_tokens, cached_tokens, cost_usd, estimated, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(run.id, stepId, run.flowId, run.flow.name, assistant, Math.round(spend.inputTokens), Math.round(spend.outputTokens), Math.round(spend.cachedTokens ?? 0), spend.costUsd, spend.estimated ? 1 : 0, now());
  }

  /** The router picked a cheaper assistant than the judge's first choice for this run: what that saved. */
  savedByCheaperPick(runId: string, savedUsd: number): void {
    this.db.prepare("UPDATE spend SET saved_usd = ?, saved_by = 'cheaper' WHERE seq = (SELECT MAX(seq) FROM spend WHERE run_id = ?)").run(savedUsd, runId);
  }

  /** The router answered from a kept answer: nothing spent, the answer's first cost saved. */
  addReuse(runId: string, assistant: string, savedUsd: number | null): void {
    this.db
      .prepare("INSERT INTO spend (run_id, step_id, flow_id, flow_name, assistant, input_tokens, output_tokens, cached_tokens, cost_usd, estimated, saved_usd, saved_by, at) VALUES (?, 'reply', NULL, ?, ?, 0, 0, 0, 0, 0, ?, 'reuse', ?)")
      .run(runId, `Router: ${assistant}`, assistant, savedUsd, now());
  }

  /** Spend since a time, per assistant: everything, or the router's calls only. */
  spendSince(since: string, routerOnly = false): SpendTotal[] {
    const rows = this.db
      .prepare(
        `SELECT assistant,
           SUM(CASE WHEN saved_by IS NOT 'reuse' THEN 1 ELSE 0 END) AS calls,
           COALESCE(SUM(cost_usd), 0) AS usd,
           SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced,
           SUM(estimated) AS estimated,
           SUM(CASE WHEN saved_by = 'reuse' THEN 1 ELSE 0 END) AS reused,
           COALESCE(SUM(CASE WHEN saved_by = 'reuse' THEN saved_usd END), 0) AS saved_by_reuse,
           SUM(CASE WHEN saved_by = 'cheaper' THEN 1 ELSE 0 END) AS cheaper,
           COALESCE(SUM(CASE WHEN saved_by = 'cheaper' THEN saved_usd END), 0) AS saved_by_cheaper
         FROM spend WHERE at >= ? ${routerOnly ? "AND flow_id IS NULL AND flow_name LIKE 'Router: %'" : ""} GROUP BY assistant ORDER BY usd DESC`,
      )
      .all(since) as Row[];
    return rows.map((row) => ({
      assistant: String(row.assistant),
      calls: Number(row.calls),
      usd: Number(row.usd),
      unpriced: Number(row.unpriced),
      estimated: Number(row.estimated),
      reused: Number(row.reused),
      savedByReuse: Number(row.saved_by_reuse),
      cheaper: Number(row.cheaper),
      savedByCheaper: Number(row.saved_by_cheaper),
    }));
  }

  /** An assistant's latest priced calls, newest first: what the router expects its next call to cost. */
  recentSpend(assistant: string, limit = 20): { costUsd: number; inputTokens: number; outputTokens: number }[] {
    return (this.db.prepare("SELECT cost_usd, input_tokens, output_tokens FROM spend WHERE assistant = ? AND cost_usd IS NOT NULL AND saved_by IS NOT 'reuse' ORDER BY seq DESC LIMIT ?").all(assistant, limit) as Row[]).map((row) => ({
      costUsd: Number(row.cost_usd),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
    }));
  }

  // Answers the router may give again ----------------------------------------------------------------

  keptAnswer(key: string): KeptAnswer | null {
    const row = this.db.prepare("SELECT * FROM answers WHERE key = ? AND expires_at > ?").get(key, now()) as Row | undefined;
    if (!row) return null;
    return { assistant: String(row.assistant), runId: String(row.run_id), text: String(row.text), data: JSON.parse(String(row.data)), costUsd: row.cost_usd === null ? null : Number(row.cost_usd) };
  }

  keepAnswer(key: string, answer: KeptAnswer, minutes: number): void {
    this.db.prepare("DELETE FROM answers WHERE expires_at <= ?").run(now());
    const expires = new Date(Date.now() + minutes * 60_000).toISOString();
    this.db.prepare("INSERT OR REPLACE INTO answers (key, assistant, run_id, text, data, cost_usd, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(key, answer.assistant, answer.runId, answer.text, JSON.stringify(answer.data ?? null), answer.costUsd, expires);
  }

  // Log --------------------------------------------------------------------------------------------

  log(runId: string, stepId: string, kind: string, detail: unknown): void {
    this.db.prepare("INSERT INTO log (run_id, step_id, kind, detail, at) VALUES (?, ?, ?, ?, ?)").run(runId, stepId, kind, JSON.stringify(detail ?? null), now());
  }

  logOf(runId: string): LogLine[] {
    return (this.db.prepare("SELECT * FROM log WHERE run_id = ? ORDER BY seq").all(runId) as Row[]).map((row) => ({
      runId: String(row.run_id),
      stepId: String(row.step_id),
      kind: String(row.kind),
      detail: JSON.parse(String(row.detail)),
      at: String(row.at),
    }));
  }
}

function toFlow(row: Row): SavedFlow {
  return {
    id: String(row.id),
    flow: JSON.parse(String(row.flow)) as Flow,
    webhookSecret: String(row.webhook_secret),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toRun(row: Row): Run {
  return {
    id: String(row.id),
    flowId: row.flow_id === null || row.flow_id === undefined ? null : String(row.flow_id),
    flow: JSON.parse(String(row.flow)) as Flow,
    state: String(row.state) as RunState,
    at: row.at === null ? null : String(row.at),
    context: JSON.parse(String(row.context)) as RunContext,
    error: row.error === null ? null : String(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toApproval(row: Row): Approval {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stepId: String(row.step_id),
    message: String(row.message),
    status: String(row.status) as Approval["status"],
    createdAt: String(row.created_at),
    decidedAt: row.decided_at === null ? null : String(row.decided_at),
  };
}

function toNote(row: Row): Note {
  return {
    id: String(row.id),
    slice: String(row.slice),
    note: String(row.note),
    status: String(row.status) as Note["status"],
    source: String(row.source),
    createdAt: String(row.created_at),
  };
}

/** Contact tokens start with this, so one can't be mistaken for Huddle's own token. */
const TOKEN_PREFIX = "hdl_c_";

function contactToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
}

/** A contact token is long and random, so a plain SHA-256 is enough to keep it from being read back. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function cleanEmails(emails: readonly string[] | undefined): string[] {
  return [...new Set((emails ?? []).map((email) => email.trim().toLowerCase()).filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))];
}

function toContact(row: Row): Contact {
  return {
    id: String(row.id),
    name: String(row.name),
    tier: String(row.tier) as ContactTier,
    emails: JSON.parse(String(row.emails)) as string[],
    createdAt: String(row.created_at),
    lastSeenAt: row.last_seen_at == null ? null : String(row.last_seen_at),
  };
}
