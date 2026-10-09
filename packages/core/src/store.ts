import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import type { Flow } from "./schema.ts";
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
  | { readonly kind: "sandbox" };

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

  suggest(slice: string, note: string, source: string): Note {
    return this.addNote(slice, note, source, "suggested");
  }

  /** A note a person writes themselves: kept straight away. */
  remember(slice: string, note: string): Note {
    return this.addNote(slice, note, "you", "kept");
  }

  keep(id: string): boolean {
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
