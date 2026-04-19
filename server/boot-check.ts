/**
 * Boot checks — runs before the app starts.
 * Validates environment, directories, database, and auth.
 * Exits with code 1 on any fatal failure.
 */

import { existsSync, mkdirSync, accessSync, constants } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

const ROOT = process.cwd();

type CheckResult = { ok: true } | { ok: false; message: string };

// ── Individual checks ──────────────────────────────────

function checkDataDir(): CheckResult {
  const dir = join(ROOT, "data");
  try {
    mkdirSync(dir, { recursive: true });
    // Verify writable
    accessSync(dir, constants.W_OK);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: `data/ directory not writable: ${err}` };
  }
}

function checkDatabase(): CheckResult {
  const dbPath = join(ROOT, "data", "robots.db");
  try {
    // Open (or create) the database and verify it responds
    const testDb = new Database(dbPath);
    testDb.pragma("journal_mode = WAL");
    const row = testDb.prepare("SELECT 1 as ok").get() as { ok: number } | undefined;
    testDb.close();
    if (row?.ok !== 1) {
      return { ok: false, message: "Database opened but SELECT 1 failed" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, message: `Database check failed: ${err}` };
  }
}

function checkConfigs(): CheckResult {
  const required = [
    "config/paradise.office.json",
    "config/dontcall.office.json",
    "config/operations.office.json",
  ];
  const missing = required.filter((f) => !existsSync(join(ROOT, f)));
  if (missing.length > 0) {
    return { ok: false, message: `Missing config files: ${missing.join(", ")}` };
  }
  return { ok: true };
}

function checkAgentWorkspaces(): CheckResult {
  const dir = join(ROOT, "agent-workspaces");
  if (!existsSync(dir)) {
    return { ok: false, message: "agent-workspaces/ directory missing" };
  }
  return { ok: true };
}

function checkNodeModules(): CheckResult {
  if (!existsSync(join(ROOT, "node_modules"))) {
    return { ok: false, message: "node_modules/ missing — run `npm install`" };
  }
  return { ok: true };
}

function checkNextBuild(): CheckResult {
  // Only relevant in production
  if (process.env.NODE_ENV !== "production") return { ok: true };
  if (!existsSync(join(ROOT, ".next"))) {
    return { ok: false, message: ".next/ missing — run `npm run build` before starting in production" };
  }
  return { ok: true };
}

function checkPort(port: number, name: string): CheckResult {
  if (isNaN(port) || port < 1 || port > 65535) {
    return { ok: false, message: `Invalid ${name} port: ${port}` };
  }
  return { ok: true };
}

// ── Runner ─────────────────────────────────────────────

type Check = { name: string; fn: () => CheckResult; fatal: boolean };

const checks: Check[] = [
  { name: "node_modules", fn: checkNodeModules, fatal: true },
  { name: "data directory", fn: checkDataDir, fatal: true },
  { name: "database", fn: checkDatabase, fatal: true },
  { name: "office configs", fn: checkConfigs, fatal: true },
  { name: "agent workspaces", fn: checkAgentWorkspaces, fatal: false },
  { name: "next build", fn: checkNextBuild, fatal: true },
  {
    name: "runner port",
    fn: () => checkPort(Number(process.env.RUNNER_PORT) || 3100, "RUNNER_PORT"),
    fatal: true,
  },
  {
    name: "next port",
    fn: () => checkPort(Number(process.env.PORT) || 3000, "PORT"),
    fatal: true,
  },
];

export function runBootChecks(): { pass: boolean; results: { name: string; ok: boolean; message?: string }[] } {
  const results: { name: string; ok: boolean; message?: string }[] = [];
  let hasFatal = false;

  for (const check of checks) {
    const result = check.fn();
    if (result.ok) {
      results.push({ name: check.name, ok: true });
    } else {
      results.push({ name: check.name, ok: false, message: result.message });
      if (check.fatal) hasFatal = true;
    }
  }

  return { pass: !hasFatal, results };
}

// ── CLI entrypoint ─────────────────────────────────────

if (process.argv[1]?.endsWith("boot-check.ts") || process.argv[1]?.endsWith("boot-check.js")) {
  const { pass, results } = runBootChecks();

  console.log("\n  boot checks\n");
  for (const r of results) {
    const icon = r.ok ? "\x1b[32m pass \x1b[0m" : "\x1b[31m FAIL \x1b[0m";
    console.log(`  ${icon} ${r.name}${r.message ? ` — ${r.message}` : ""}`);
  }
  console.log();

  if (!pass) {
    console.error("  Fatal check(s) failed. Fix the above before starting.\n");
    process.exit(1);
  }
  console.log("  All checks passed.\n");
}
