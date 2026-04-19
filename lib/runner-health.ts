/**
 * Runner health check — pings the agent-runner and verifies it's the
 * expected instance (same project, not a stale/foreign runner).
 */

const RUNNER_URL = process.env.RUNNER_URL ?? "http://127.0.0.1:3101";

export type RunnerStatus =
  | { ok: true }
  | { ok: false; reason: "unreachable" | "wrong_runner" | "error"; detail: string };

/**
 * Ping the runner. Returns { ok: true } if reachable,
 * or a descriptive error if not.
 */
export async function checkRunner(): Promise<RunnerStatus> {
  try {
    const res = await fetch(`${RUNNER_URL}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      return { ok: false, reason: "error", detail: `runner returned ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("abort")) {
      return {
        ok: false,
        reason: "unreachable",
        detail: `Agent runner is not reachable at ${RUNNER_URL}. Is it running?`,
      };
    }
    return { ok: false, reason: "error", detail: msg };
  }
}
