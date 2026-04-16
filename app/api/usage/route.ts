import { NextResponse } from "next/server";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

const WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours
const LIMIT_TOKENS = 500_000;

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
    limit: LIMIT_TOKENS,
    pct: Math.min(1, tokens / LIMIT_TOKENS),
  });
}
