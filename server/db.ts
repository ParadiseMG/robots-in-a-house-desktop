import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import paradiseRaw from "../config/paradise.office.json" with { type: "json" };
import dontcallRaw from "../config/dontcall.office.json" with { type: "json" };
import operationsRaw from "../config/operations.office.json" with { type: "json" };
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
  status: "starting" | "running" | "awaiting_input" | "done" | "error";
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
  const row = d
    .prepare(
      "SELECT * FROM prompt_queue WHERE agent_id = ? AND office_slug = ? ORDER BY queued_at ASC LIMIT 1",
    )
    .get(agentId, officeSlug) as PromptQueueRow | undefined;
  if (!row) return null;
  d.prepare("DELETE FROM prompt_queue WHERE id = ?").run(row.id);
  return row;
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

/** Count queued prompts for an agent. */
export function queueDepth(officeSlug: string, agentId: string): number {
  const row = db()
    .prepare(
      "SELECT COUNT(*) as n FROM prompt_queue WHERE agent_id = ? AND office_slug = ?",
    )
    .get(agentId, officeSlug) as { n: number };
  return row.n;
}
