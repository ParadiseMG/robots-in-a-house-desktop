/**
 * Production startup script.
 *
 * 1. Runs boot checks
 * 2. Spawns Next.js + agent runner as child processes
 * 3. Handles SIGTERM/SIGINT — gracefully shuts both down
 * 4. Auto-restarts the runner on crash (with backoff)
 *
 * Usage:
 *   npm run start:prod          (production — requires `npm run build` first)
 *   npm run start:dev           (development — uses `next dev`)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { runBootChecks } from "./boot-check.js";

const IS_DEV = process.env.NODE_ENV !== "production";
const RUNNER_PORT = process.env.RUNNER_PORT || "3100";

// ── Boot checks ────────────────────────────────────────

console.log("[startup] running boot checks...");
const { pass, results } = runBootChecks();

for (const r of results) {
  const icon = r.ok ? "\x1b[32m+\x1b[0m" : "\x1b[31mx\x1b[0m";
  console.log(`  ${icon} ${r.name}${r.message ? ` — ${r.message}` : ""}`);
}

if (!pass) {
  console.error("\n[startup] fatal check(s) failed. Aborting.\n");
  process.exit(1);
}

console.log("[startup] all checks passed\n");

// ── Process management ─────────────────────────────────

let nextProc: ChildProcess | null = null;
let runnerProc: ChildProcess | null = null;
let shuttingDown = false;

// Runner restart backoff: 1s, 2s, 4s, 8s, 16s, 30s max
let runnerRestarts = 0;
const MAX_BACKOFF_MS = 30_000;

function backoffMs(): number {
  const ms = Math.min(1000 * Math.pow(2, runnerRestarts), MAX_BACKOFF_MS);
  return ms;
}

function startNext(): ChildProcess {
  const cmd = IS_DEV ? "npx" : "npx";
  const args = IS_DEV ? ["next", "dev"] : ["next", "start"];

  console.log(`[startup] starting next.js (${IS_DEV ? "dev" : "prod"})...`);
  const proc = spawn(cmd, args, {
    stdio: "inherit",
    env: { ...process.env },
  });

  proc.on("exit", (code) => {
    if (shuttingDown) return;
    console.error(`[startup] next.js exited with code ${code}. Shutting down.`);
    shutdown(code ?? 1);
  });

  return proc;
}

function startRunner(): ChildProcess {
  console.log(`[startup] starting agent runner on :${RUNNER_PORT}...`);
  const proc = spawn("npx", ["tsx", "server/agent-runner.ts"], {
    stdio: "inherit",
    env: { ...process.env, RUNNER_PORT },
  });

  proc.on("exit", (code) => {
    if (shuttingDown) return;
    runnerRestarts++;
    const delay = backoffMs();
    console.error(
      `[startup] runner exited with code ${code}. Restarting in ${delay}ms (attempt ${runnerRestarts})...`
    );
    setTimeout(() => {
      if (!shuttingDown) {
        runnerProc = startRunner();
      }
    }, delay);
  });

  // Reset backoff counter after 60s of stable running
  const stabilityTimer = setTimeout(() => {
    runnerRestarts = 0;
  }, 60_000);
  proc.on("exit", () => clearTimeout(stabilityTimer));

  return proc;
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[startup] shutting down...");

  const kill = (proc: ChildProcess | null, name: string) => {
    if (!proc || proc.killed) return;
    console.log(`[startup] stopping ${name} (pid ${proc.pid})...`);
    proc.kill("SIGTERM");
    // Force kill after 5s if still alive
    setTimeout(() => {
      if (!proc.killed) {
        console.log(`[startup] force-killing ${name}`);
        proc.kill("SIGKILL");
      }
    }, 5000);
  };

  kill(runnerProc, "runner");
  kill(nextProc, "next.js");

  // Give children time to exit, then bail
  setTimeout(() => {
    console.log("[startup] exit.");
    process.exit(exitCode);
  }, 6000);
}

// ── Signal handlers ────────────────────────────────────

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

// ── Launch ─────────────────────────────────────────────

nextProc = startNext();
runnerProc = startRunner();

console.log("[startup] all processes launched. Press Ctrl+C to stop.\n");
