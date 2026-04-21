import { NextResponse } from "next/server";
import { recentRunsByOffice } from "@/server/db";
import { withErrorReporting } from "@/lib/api-error-handler";

export const dynamic = "force-dynamic";

/**
 * GET /api/activity?offices=paradise,dontcall,operations
 *
 * Returns recent terminal runs grouped by agent_id for sparkline rendering.
 * Each agent gets up to `limit` most recent runs (default 8).
 */
export const GET = withErrorReporting("GET /api/activity", async (req: Request) => {
  const url = new URL(req.url);
  const officeParam = url.searchParams.get("offices") ?? "";
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "8") || 8, 20);

  const slugs = officeParam.split(",").map((s) => s.trim()).filter(Boolean);
  if (slugs.length === 0) {
    return NextResponse.json({ error: "missing offices param" }, { status: 400 });
  }

  // Fetch runs from all requested offices
  const allRows = slugs.flatMap((slug) => recentRunsByOffice(slug, limit));

  // Group by agent_id, keep only `limit` per agent, sorted oldest-first
  const byAgent: Record<string, Array<{ status: string; startedAt: number; endedAt: number | null }>> = {};
  for (const row of allRows) {
    const arr = byAgent[row.agent_id] ?? [];
    if (arr.length < limit) {
      arr.push({ status: row.status, startedAt: row.started_at, endedAt: row.ended_at });
    }
    byAgent[row.agent_id] = arr;
  }

  // Reverse each agent's array so it's oldest-first (sparkline reads left-to-right)
  for (const agentId of Object.keys(byAgent)) {
    byAgent[agentId].reverse();
  }

  return NextResponse.json({ activity: byAgent });
});
