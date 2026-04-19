import { NextResponse } from "next/server";
import { execSync } from "node:child_process";

export const dynamic = "force-dynamic";

type Check = {
  id: string;
  label: string;
  status: "ok" | "warn" | "error";
  detail: string;
};

/**
 * GET /api/health
 *
 * Checks critical dependencies for running agents:
 * - Claude auth (OAuth or API key)
 * - git installed
 * - Node.js version
 * - Agent runner reachable
 */
export async function GET() {
  const checks: Check[] = [];

  // 1. Claude auth
  try {
    // Try `claude auth status` first (Claude Max / OAuth path)
    const authJson = execSync("claude auth status 2>&1", {
      timeout: 5000,
      encoding: "utf-8",
    });
    const auth = JSON.parse(authJson);
    if (auth.loggedIn) {
      checks.push({
        id: "claude-auth",
        label: "Claude auth",
        status: "ok",
        detail: `Authenticated via ${auth.authMethod ?? "OAuth"}${auth.email ? ` (${auth.email})` : ""}`,
      });
    } else {
      // CLI exists but not logged in — check for API key fallback
      if (process.env.ANTHROPIC_API_KEY) {
        checks.push({
          id: "claude-auth",
          label: "Claude auth",
          status: "ok",
          detail: "Using ANTHROPIC_API_KEY from environment",
        });
      } else {
        checks.push({
          id: "claude-auth",
          label: "Claude auth",
          status: "error",
          detail: "Not authenticated. Run `claude setup-token` or set ANTHROPIC_API_KEY in .env.local",
        });
      }
    }
  } catch {
    // claude CLI not found or errored — check API key
    if (process.env.ANTHROPIC_API_KEY) {
      checks.push({
        id: "claude-auth",
        label: "Claude auth",
        status: "ok",
        detail: "Using ANTHROPIC_API_KEY from environment",
      });
    } else {
      checks.push({
        id: "claude-auth",
        label: "Claude auth",
        status: "error",
        detail: "Claude CLI not found and no API key set. Run `npm i -g @anthropic-ai/claude-code && claude setup-token` or set ANTHROPIC_API_KEY in .env.local",
      });
    }
  }

  // 2. Git
  try {
    const gitVersion = execSync("git --version 2>&1", {
      timeout: 3000,
      encoding: "utf-8",
    }).trim();
    checks.push({
      id: "git",
      label: "Git",
      status: "ok",
      detail: gitVersion,
    });
  } catch {
    checks.push({
      id: "git",
      label: "Git",
      status: "error",
      detail: "Git not found. Install from https://git-scm.com",
    });
  }

  // 3. Node.js version
  try {
    const nodeVersion = process.version;
    const major = parseInt(nodeVersion.slice(1), 10);
    checks.push({
      id: "node",
      label: "Node.js",
      status: major >= 18 ? "ok" : "warn",
      detail: `${nodeVersion}${major < 18 ? " (v18+ recommended)" : ""}`,
    });
  } catch {
    checks.push({
      id: "node",
      label: "Node.js",
      status: "warn",
      detail: "Could not determine version",
    });
  }

  // 4. Agent runner reachable
  try {
    const runnerPort = process.env.RUNNER_PORT ?? "3100";
    const res = await fetch(`http://localhost:${runnerPort}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      checks.push({
        id: "runner",
        label: "Agent runner",
        status: "ok",
        detail: `Running on port ${runnerPort}`,
      });
    } else {
      checks.push({
        id: "runner",
        label: "Agent runner",
        status: "warn",
        detail: `Responded with ${res.status}. Try restarting npm run dev`,
      });
    }
  } catch {
    const runnerPort = process.env.RUNNER_PORT ?? "3100";
    checks.push({
      id: "runner",
      label: "Agent runner",
      status: "warn",
      detail: `Not reachable on port ${runnerPort}. Make sure npm run dev is running`,
    });
  }

  const hasError = checks.some((c) => c.status === "error");
  const hasWarn = checks.some((c) => c.status === "warn");

  return NextResponse.json({
    status: hasError ? "error" : hasWarn ? "warn" : "ok",
    checks,
  });
}
