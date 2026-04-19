import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import paradiseRaw from "../config/paradise.office.json" with { type: "json" };
import dontcallRaw from "../config/dontcall.office.json" with { type: "json" };
import operationsRaw from "../config/operations.office.json" with { type: "json" };
import launchosRaw from "../config/launchos.office.json" with { type: "json" };
import type { OfficeConfig } from "../lib/office-types.js";

const DB_DIR = join(process.cwd(), "data");
const DB_PATH = join(DB_DIR, "robots.db");

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;
  mkdirSync(DB_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  migrate(_db);
  seedIfEmpty(_db);
  return _db;
}

function migrate(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      office_slug TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'tray',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_office ON tasks(office_slug, status);

    CREATE TABLE IF NOT EXISTS assignments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      agent_id TEXT NOT NULL,
      desk_id TEXT NOT NULL,
      office_slug TEXT NOT NULL,
      assigned_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_assignments_agent ON assignments(agent_id, completed_at);
    CREATE INDEX IF NOT EXISTS idx_assignments_office ON assignments(office_slug, completed_at);

    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL REFERENCES assignments(id),
      agent_id TEXT NOT NULL,
      office_slug TEXT NOT NULL,
      session_id TEXT,
      status TEXT NOT NULL DEFAULT 'starting',
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      last_token_at INTEGER,
      error TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_creation_tokens INTEGER,
      acknowledged_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_runs_assignment ON agent_runs(assignment_id);
    CREATE INDEX IF NOT EXISTS idx_runs_agent ON agent_runs(agent_id, started_at);

    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES agent_runs(id),
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(run_id, id);

    CREATE TABLE IF NOT EXISTS session_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      office_slug TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      reset_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_resets_agent ON session_resets(office_slug, agent_id, reset_at);

    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      office_slug TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      convened_by TEXT NOT NULL,
      prompt TEXT NOT NULL,
      convened_at INTEGER NOT NULL,
      target_rounds INTEGER NOT NULL DEFAULT 1,
      synthesis_run_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_meetings_office ON meetings(office_slug, convened_at);

    CREATE TABLE IF NOT EXISTS meeting_attendees (
      meeting_id TEXT NOT NULL REFERENCES meetings(id),
      agent_id TEXT NOT NULL,
      assignment_id TEXT NOT NULL REFERENCES assignments(id),
      PRIMARY KEY (meeting_id, agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_meeting_attendees_assignment ON meeting_attendees(assignment_id);

    CREATE TABLE IF NOT EXISTS prompt_queue (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      office_slug TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      queued_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prompt_queue_agent ON prompt_queue(agent_id, office_slug, queued_at);

    CREATE TABLE IF NOT EXISTS rate_limit_state (
      key TEXT PRIMARY KEY,
      utilization REAL NOT NULL DEFAULT 0,
      resets_at INTEGER,
      status TEXT NOT NULL DEFAULT 'allowed',
      rate_limit_type TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS error_log (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      source TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'error',
      message TEXT NOT NULL,
      stack TEXT,
      agent_id TEXT,
      office_slug TEXT,
      run_id TEXT,
      context TEXT,
      acknowledged_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_error_log_ts ON error_log(ts);
    CREATE INDEX IF NOT EXISTS idx_error_log_source ON error_log(source, ts);
  `);

  // Idempotent column additions for agent_runs (pre-existing DBs)
  const cols = (
    d.prepare("PRAGMA table_info(agent_runs)").all() as Array<{ name: string }>
  ).map((r) => r.name);
  const add = (name: string, ddl: string) => {
    if (!cols.includes(name)) d.exec(`ALTER TABLE agent_runs ADD COLUMN ${ddl}`);
  };
  add("input_tokens", "input_tokens INTEGER");
  add("output_tokens", "output_tokens INTEGER");
  add("cache_read_tokens", "cache_read_tokens INTEGER");
  add("cache_creation_tokens", "cache_creation_tokens INTEGER");
  add("acknowledged_at", "acknowledged_at INTEGER");
  add("delegated_by_agent_id", "delegated_by_agent_id TEXT");
  add("delegated_by_run_id", "delegated_by_run_id TEXT");
  // Index for roster query: count active children per parent
  d.exec(
    "CREATE INDEX IF NOT EXISTS idx_runs_delegated_by ON agent_runs(delegated_by_agent_id, status)",
  );

  // Idempotent column additions for meetings (pre-existing DBs)
  const mcols = (
    d.prepare("PRAGMA table_info(meetings)").all() as Array<{ name: string }>
  ).map((r) => r.name);
  if (!mcols.includes("target_rounds")) {
    d.exec("ALTER TABLE meetings ADD COLUMN target_rounds INTEGER NOT NULL DEFAULT 1");
  }
  if (!mcols.includes("synthesis_run_id")) {
    d.exec("ALTER TABLE meetings ADD COLUMN synthesis_run_id TEXT");
  }
}

export function upsertRateLimit(info: {
  key: string;
  utilization: number;
  resetsAt?: number;
  status: string;
  rateLimitType?: string;
}) {
  db()
    .prepare(
      `INSERT INTO rate_limit_state (key, utilization, resets_at, status, rate_limit_type, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         utilization = excluded.utilization,
         resets_at = excluded.resets_at,
         status = excluded.status,
         rate_limit_type = excluded.rate_limit_type,
         updated_at = excluded.updated_at`,
    )
    .run(info.key, info.utilization, info.resetsAt ?? null, info.status, info.rateLimitType ?? null, Date.now());
}

export function getRateLimit(key: string) {
  return db()
    .prepare("SELECT * FROM rate_limit_state WHERE key = ?")
    .get(key) as {
      key: string;
      utilization: number;
      resets_at: number | null;
      status: string;
      rate_limit_type: string | null;
      updated_at: number;
    } | undefined;
}

export function getAllRateLimits() {
  return db()
    .prepare("SELECT * FROM rate_limit_state ORDER BY key")
    .all() as Array<{
      key: string;
      utilization: number;
      resets_at: number | null;
      status: string;
      rate_limit_type: string | null;
      updated_at: number;
    }>;
}

export function getResumeSessionId(
  officeSlug: string,
  agentId: string,
): string | null {
  const d = db();
  const lastReset = d
    .prepare(
      "SELECT reset_at FROM session_resets WHERE office_slug = ? AND agent_id = ? ORDER BY reset_at DESC LIMIT 1",
    )
    .get(officeSlug, agentId) as { reset_at: number } | undefined;
  const cutoff = lastReset?.reset_at ?? 0;
  const row = d
    .prepare(
      `SELECT session_id FROM agent_runs
       WHERE office_slug = ? AND agent_id = ? AND session_id IS NOT NULL AND started_at > ?
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(officeSlug, agentId, cutoff) as { session_id: string } | undefined;
  return row?.session_id ?? null;
}

function seedIfEmpty(d: Database.Database) {
  const n = (d.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
  if (n > 0) return;

  const insert = d.prepare(
    "INSERT INTO tasks (id, office_slug, title, body, status, created_at) VALUES (?, ?, ?, ?, 'tray', ?)",
  );
  const now = Date.now();
  const seed = [
    ["paradise", "Summarize last 3 event recaps", "Pull the Notion pages for the last 3 Paradise shows and extract headlines."],
    ["paradise", "Draft Friday show announce copy", "SMS + IG caption, 160 chars each."],
    ["paradise", "Chase 2 unsigned artist contracts", "Who's outstanding? Post list."],
    ["dontcall", "Lead triage — new inbound SMS", "Classify, dedupe, tag by trade."],
    ["dontcall", "Route 3 queued jobs to tradesmen", "Match by zip + availability."],
    ["dontcall", "Nightly callback list", "Pull queue, sort by priority."],
    ["operations", "Check deployment pipeline status", "Review the CI/CD pipeline for all environments. Report any failing builds, stuck deployments, or stale preview URLs."],
    ["operations", "Audit environment variables", "Compare environment variables across dev, staging, and production. Flag any missing or inconsistent values."],
  ];
  const insertMany = d.transaction((rows: typeof seed) => {
    for (const [office, title, body] of rows) {
      insert.run(crypto.randomUUID(), office, title, body, now);
    }
  });
  insertMany(seed);
}

// ---- Helpers for config lookups (not persisted — offices are config-driven) ----
// Read fresh from disk each call so newly-created agents are visible without a
// server restart. Fall back to the bundled import if the file read fails.

const FALLBACK_OFFICES: Record<string, OfficeConfig> = {
  paradise: paradiseRaw as OfficeConfig,
  dontcall: dontcallRaw as OfficeConfig,
  operations: operationsRaw as OfficeConfig,
  launchos: launchosRaw as OfficeConfig,
};

function loadOffice(officeSlug: string): OfficeConfig | null {
  try {
    const raw = readFileSync(
      join(process.cwd(), "config", `${officeSlug}.office.json`),
      "utf-8",
    );
    return JSON.parse(raw) as OfficeConfig;
  } catch {
    return FALLBACK_OFFICES[officeSlug] ?? null;
  }
}

export function getAgent(officeSlug: string, agentId: string) {
  const office = loadOffice(officeSlug);
  if (!office) return null;
  const agent = office.agents.find((a) => a.id === agentId);
  if (!agent) return null;
  return { ...agent, officeSlug };
}

export function getDeskForAgent(officeSlug: string, agentId: string) {
  const office = loadOffice(officeSlug);
  if (!office) return null;
  const agent = office.agents.find((a) => a.id === agentId);
  if (!agent) return null;
  return office.desks.find((desk) => desk.id === agent.deskId) ?? null;
}

// ---- Typed row shapes ----

export type TaskRow = {
  id: string;
  office_slug: string;
  title: string;
  body: string;
  status: "tray" | "assigned" | "done";
  created_at: number;
};

export type AssignmentRow = {
  id: string;
  task_id: string;
  agent_id: string;
  desk_id: string;
  office_slug: string;
  assigned_at: number;
  completed_at: number | null;
};

export type AgentRunRow = {
  id: string;
  assignment_id: string;
  agent_id: string;
  office_slug: string;
  session_id: string | null;
  status: "starting" | "running" | "awaiting_input" | "done" | "error" | "interrupted";
  started_at: number;
  ended_at: number | null;
  last_token_at: number | null;
  error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  acknowledged_at: number | null;
  delegated_by_agent_id: string | null;
  delegated_by_run_id: string | null;
};

export type RunEventRow = {
  id: number;
  run_id: string;
  ts: number;
  kind: "assistant" | "tool_use" | "tool_result" | "status";
  payload: string;
};

export type PromptQueueRow = {
  id: string;
  agent_id: string;
  office_slug: string;
  title: string;
  prompt: string;
  queued_at: number;
};

/** Returns true if the agent has an active (non-terminal) run. */
export function agentIsBusy(officeSlug: string, agentId: string): boolean {
  const row = db()
    .prepare(
      `SELECT r.id FROM agent_runs r
       JOIN assignments a ON a.id = r.assignment_id
       WHERE r.agent_id = ? AND r.office_slug = ? AND r.status IN ('starting', 'running', 'awaiting_input')
       LIMIT 1`,
    )
    .get(agentId, officeSlug) as { id: string } | undefined;
  return !!row;
}

/** Queue a prompt for an agent. Returns the queue entry id. */
export function enqueuePrompt(
  agentId: string,
  officeSlug: string,
  title: string,
  prompt: string,
): string {
  const id = crypto.randomUUID();
  db()
    .prepare(
      "INSERT INTO prompt_queue (id, agent_id, office_slug, title, prompt, queued_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, agentId, officeSlug, title, prompt, Date.now());
  return id;
}

/** Pop the next queued prompt for an agent (FIFO). Returns null if empty. */
export function dequeuePrompt(
  agentId: string,
  officeSlug: string,
): PromptQueueRow | null {
  const d = db();
  return d.transaction(() => {
    const row = d
      .prepare(
        "SELECT * FROM prompt_queue WHERE agent_id = ? AND office_slug = ? ORDER BY queued_at ASC LIMIT 1",
      )
      .get(agentId, officeSlug) as PromptQueueRow | undefined;
    if (!row) return null;
    const deleted = d.prepare("DELETE FROM prompt_queue WHERE id = ?").run(row.id);
    if (deleted.changes === 0) return null;
    return row;
  })();
}

/**
 * Count active (non-terminal) runs that were delegated by the given agent.
 * Used to visualize satellites around a delegating "boss" agent.
 */
export function activeDelegationsFor(
  officeSlug: string,
  delegatorAgentId: string,
): number {
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS n FROM agent_runs
       WHERE delegated_by_agent_id = ? AND office_slug = ?
         AND status IN ('starting', 'running', 'awaiting_input')`,
    )
    .get(delegatorAgentId, officeSlug) as { n: number };
  return row.n;
}

/**
 * Batch variant of activeDelegationsFor — one query per office, returns a map
 * of delegator agentId -> count. Roster renders every agent on every poll,
 * so avoid N+1.
 */
export function activeDelegationsByDelegator(
  officeSlug: string,
): Map<string, number> {
  const rows = db()
    .prepare(
      `SELECT delegated_by_agent_id AS id, COUNT(*) AS n FROM agent_runs
       WHERE office_slug = ?
         AND delegated_by_agent_id IS NOT NULL
         AND status IN ('starting', 'running', 'awaiting_input')
       GROUP BY delegated_by_agent_id`,
    )
    .all(officeSlug) as Array<{ id: string; n: number }>;
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.id, r.n);
  return m;
}

/**
 * Returns active delegation pairs for an office: [{delegatorId, delegateeId}].
 * Used to draw beam lines from delegator sprite to delegate sprite.
 */
export function activeDelegationLinks(
  officeSlug: string,
): Array<{ delegatorId: string; delegateeId: string }> {
  const rows = db()
    .prepare(
      `SELECT delegated_by_agent_id AS delegatorId, agent_id AS delegateeId
       FROM agent_runs
       WHERE office_slug = ?
         AND delegated_by_agent_id IS NOT NULL
         AND status IN ('starting', 'running', 'awaiting_input')`,
    )
    .all(officeSlug) as Array<{ delegatorId: string; delegateeId: string }>;
  return rows;
}

/**
 * Look up a delegated run for the caller. Returns enough to answer "is it
 * done, and what did they say?" — status + last assistant text + final result
 * + pending input question if any. Returns null if the run doesn't exist OR
 * the caller isn't the delegator (authorization — you can only peek at your
 * own delegations).
 */
export function getDelegationStatus(
  runId: string,
  delegatorAgentId: string,
): {
  runId: string;
  agentId: string;
  officeSlug: string;
  status: "starting" | "running" | "awaiting_input" | "done" | "error" | "interrupted";
  startedAt: number;
  endedAt: number | null;
  lastAssistantText: string | null;
  finalResult: string | null;
  error: string | null;
  pendingQuestion: string | null;
  taskTitle: string | null;
} | null {
  const d = db();
  const run = d
    .prepare(
      `SELECT r.id, r.agent_id, r.office_slug, r.status, r.started_at, r.ended_at,
              r.error, r.delegated_by_agent_id, r.assignment_id
       FROM agent_runs r WHERE r.id = ?`,
    )
    .get(runId) as
    | (Pick<
        AgentRunRow,
        | "id"
        | "agent_id"
        | "office_slug"
        | "status"
        | "started_at"
        | "ended_at"
        | "error"
        | "delegated_by_agent_id"
        | "assignment_id"
      >)
    | undefined;
  if (!run) return null;
  if (run.delegated_by_agent_id !== delegatorAgentId) return null;

  // Last assistant text (most recent progress line)
  const lastAssistant = d
    .prepare(
      `SELECT payload FROM run_events
       WHERE run_id = ? AND kind = 'assistant'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(runId) as { payload: string } | undefined;
  let lastAssistantText: string | null = null;
  if (lastAssistant) {
    try {
      const parsed = JSON.parse(lastAssistant.payload) as { text?: string };
      lastAssistantText = parsed.text ?? null;
    } catch {}
  }

  // Final result (from the 'done' status event)
  let finalResult: string | null = null;
  if (run.status === "done") {
    const doneEvent = d
      .prepare(
        `SELECT payload FROM run_events
         WHERE run_id = ? AND kind = 'status'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(runId) as { payload: string } | undefined;
    if (doneEvent) {
      try {
        const parsed = JSON.parse(doneEvent.payload) as { result?: string };
        finalResult = parsed.result ?? null;
      } catch {}
    }
  }

  // Pending question (if awaiting_input)
  let pendingQuestion: string | null = null;
  if (run.status === "awaiting_input") {
    const q = d
      .prepare(
        `SELECT payload FROM run_events
         WHERE run_id = ? AND kind = 'input_request'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(runId) as { payload: string } | undefined;
    if (q) {
      try {
        const parsed = JSON.parse(q.payload) as { question?: string };
        pendingQuestion = parsed.question ?? null;
      } catch {}
    }
  }

  // Task title (for delegator who lost track of what they sent)
  const task = d
    .prepare(
      `SELECT t.title FROM tasks t
       JOIN assignments a ON a.task_id = t.id
       WHERE a.id = ? LIMIT 1`,
    )
    .get(run.assignment_id) as { title: string } | undefined;

  return {
    runId: run.id,
    agentId: run.agent_id,
    officeSlug: run.office_slug,
    status: run.status,
    startedAt: run.started_at,
    endedAt: run.ended_at,
    lastAssistantText,
    finalResult,
    error: run.error,
    pendingQuestion,
    taskTitle: task?.title ?? null,
  };
}

/**
 * List recent delegations dispatched by a given agent. Returns up to `limit`
 * runs ordered newest first. Used when the delegator asks "what did I send
 * out?" without a specific runId.
 */
export function listDelegationsBy(
  delegatorAgentId: string,
  officeSlug: string,
  limit = 10,
): Array<{
  runId: string;
  agentId: string;
  status: AgentRunRow["status"];
  startedAt: number;
  endedAt: number | null;
  taskTitle: string | null;
}> {
  const rows = db()
    .prepare(
      `SELECT r.id AS runId, r.agent_id AS agentId, r.status, r.started_at AS startedAt,
              r.ended_at AS endedAt, t.title AS taskTitle
       FROM agent_runs r
       LEFT JOIN assignments a ON a.id = r.assignment_id
       LEFT JOIN tasks t ON t.id = a.task_id
       WHERE r.delegated_by_agent_id = ? AND r.office_slug = ?
       ORDER BY r.started_at DESC
       LIMIT ?`,
    )
    .all(delegatorAgentId, officeSlug, limit) as Array<{
    runId: string;
    agentId: string;
    status: AgentRunRow["status"];
    startedAt: number;
    endedAt: number | null;
    taskTitle: string | null;
  }>;
  return rows;
}

/** Count queued prompts for an agent. */
export function queueDepth(officeSlug: string, agentId: string): number {
  const row = db()
    .prepare(
      "SELECT COUNT(*) as n FROM prompt_queue WHERE agent_id = ? AND office_slug = ?",
    )
    .get(agentId, officeSlug) as { n: number };
  return row.n;
}

// ---- Error log ----

export type ErrorLogRow = {
  id: string;
  ts: number;
  source: "runner" | "api" | "agent" | "frontend";
  severity: "error" | "warn" | "fatal";
  message: string;
  stack: string | null;
  agent_id: string | null;
  office_slug: string | null;
  run_id: string | null;
  context: string | null;
  acknowledged_at: number | null;
};

export function insertError(entry: {
  source: ErrorLogRow["source"];
  severity?: ErrorLogRow["severity"];
  message: string;
  stack?: string | null;
  agentId?: string | null;
  officeSlug?: string | null;
  runId?: string | null;
  context?: Record<string, unknown> | null;
}): string {
  const id = crypto.randomUUID();
  db()
    .prepare(
      `INSERT INTO error_log (id, ts, source, severity, message, stack, agent_id, office_slug, run_id, context)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      Date.now(),
      entry.source,
      entry.severity ?? "error",
      entry.message,
      entry.stack ?? null,
      entry.agentId ?? null,
      entry.officeSlug ?? null,
      entry.runId ?? null,
      entry.context ? JSON.stringify(entry.context) : null,
    );
  return id;
}

export function queryErrors(opts?: {
  source?: string;
  severity?: string;
  officeSlug?: string;
  agentId?: string;
  since?: number;
  limit?: number;
  includeAcked?: boolean;
}): ErrorLogRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts?.source) {
    conditions.push("source = ?");
    params.push(opts.source);
  }
  if (opts?.severity) {
    conditions.push("severity = ?");
    params.push(opts.severity);
  }
  if (opts?.officeSlug) {
    conditions.push("office_slug = ?");
    params.push(opts.officeSlug);
  }
  if (opts?.agentId) {
    conditions.push("agent_id = ?");
    params.push(opts.agentId);
  }
  if (opts?.since) {
    conditions.push("ts > ?");
    params.push(opts.since);
  }
  if (!opts?.includeAcked) {
    conditions.push("acknowledged_at IS NULL");
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts?.limit ?? 50;

  return db()
    .prepare(`SELECT * FROM error_log ${where} ORDER BY ts DESC LIMIT ?`)
    .all(...params, limit) as ErrorLogRow[];
}

export function ackError(id: string): void {
  db()
    .prepare("UPDATE error_log SET acknowledged_at = ? WHERE id = ?")
    .run(Date.now(), id);
}

export function ackAllErrors(): void {
  db()
    .prepare("UPDATE error_log SET acknowledged_at = ? WHERE acknowledged_at IS NULL")
    .run(Date.now());
}

export function errorCount(since?: number): number {
  const cutoff = since ?? Date.now() - 24 * 60 * 60 * 1000;
  const row = db()
    .prepare("SELECT COUNT(*) as n FROM error_log WHERE ts > ? AND acknowledged_at IS NULL")
    .get(cutoff) as { n: number };
  return row.n;
}
