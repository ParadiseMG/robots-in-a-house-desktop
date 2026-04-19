/**
 * Centralized error reporter.
 *
 * - Inserts into the error_log SQLite table (queryable via API + UI)
 * - Appends to data/errors.jsonl (tail -f from shell)
 * - Logs to stderr with a short summary
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { insertError, type ErrorLogRow } from "./db.js";

const LOG_DIR = join(process.cwd(), "data");
const JSONL_PATH = join(LOG_DIR, "errors.jsonl");

mkdirSync(LOG_DIR, { recursive: true });

export type ErrorReport = {
  source: ErrorLogRow["source"];
  severity?: ErrorLogRow["severity"];
  message: string;
  error?: unknown;
  agentId?: string;
  officeSlug?: string;
  runId?: string;
  context?: Record<string, unknown>;
};

/**
 * Report an error. Writes to DB + JSONL + stderr.
 * Safe to call from anywhere — never throws.
 */
export function reportError(report: ErrorReport): string | null {
  const stack =
    report.error instanceof Error
      ? report.error.stack ?? null
      : report.error
        ? String(report.error)
        : null;

  const severity = report.severity ?? "error";

  // JSONL line for shell tailing
  const jsonlEntry = {
    ts: new Date().toISOString(),
    source: report.source,
    severity,
    message: report.message,
    agentId: report.agentId ?? null,
    officeSlug: report.officeSlug ?? null,
    runId: report.runId ?? null,
    ...(report.context ? { context: report.context } : {}),
    ...(stack ? { stack: stack.split("\n").slice(0, 5).join(" | ") } : {}),
  };

  try {
    appendFileSync(JSONL_PATH, JSON.stringify(jsonlEntry) + "\n");
  } catch {
    // Don't let file writes break the caller
  }

  // stderr summary
  const prefix = `[${report.source}]${report.agentId ? ` ${report.agentId}` : ""}`;
  console.error(`${prefix} ${severity}: ${report.message}`);

  // DB insert
  try {
    return insertError({
      source: report.source,
      severity,
      message: report.message,
      stack,
      agentId: report.agentId,
      officeSlug: report.officeSlug,
      runId: report.runId,
      context: report.context,
    });
  } catch (dbErr) {
    console.error("[error-reporter] failed to write to DB:", dbErr);
    return null;
  }
}
