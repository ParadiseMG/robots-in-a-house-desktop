import { NextResponse } from "next/server";
import { db, getAllRateLimits } from "@/server/db";

export const dynamic = "force-dynamic";

const WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours

export async function GET() {
  const since = Date.now() - WINDOW_MS;
  const d = db();

  const row = d
    .prepare(
      `SELECT
         COUNT(*) AS runs,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens
       FROM agent_runs
       WHERE started_at > ?
         AND input_tokens IS NOT NULL`,
    )
    .get(since) as {
      runs: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
    };

  const tokens = row.input_tokens + row.output_tokens;

  // Pull real rate limit data from Anthropic (captured from SDK events).
  // A row is stale if (a) it was last updated before the current window, or
  // (b) its resetsAt timestamp has passed — the window rolled over and the
  // utilization is no longer accurate. Drop stale rows so the bar disappears.
  const now = Date.now();
  const rateLimits = getAllRateLimits();
  const isStale = (r: { updated_at: number; resets_at: number | null }) =>
    r.updated_at < since || (r.resets_at !== null && r.resets_at * 1000 < now);
  const fiveHour = rateLimits.find((r) => r.key === "five_hour" && !isStale(r));
  const sevenDay = rateLimits.find((r) => r.key === "seven_day" && !isStale(r));

  return NextResponse.json({
    windowMs: WINDOW_MS,
    since,
    until: Date.now(),
    runs: row.runs,
    tokens,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    // Real utilization from Anthropic (null if no data yet)
    fiveHour: fiveHour
      ? {
          utilization: fiveHour.utilization,
          resetsAt: fiveHour.resets_at,
          status: fiveHour.status,
          updatedAt: fiveHour.updated_at,
        }
      : null,
    sevenDay: sevenDay
      ? {
          utilization: sevenDay.utilization,
          resetsAt: sevenDay.resets_at,
          status: sevenDay.status,
          updatedAt: sevenDay.updated_at,
        }
      : null,
  });
}
