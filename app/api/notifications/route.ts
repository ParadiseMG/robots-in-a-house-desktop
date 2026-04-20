import { NextResponse } from "next/server";
import { db, getAgent, getPendingToolApprovals } from "@/server/db";

export const dynamic = "force-dynamic";

type RunRow = {
  id: string;
  agent_id: string;
  office_slug: string;
  status: "done" | "error" | "awaiting_input";
  ended_at: number | null;
  started_at: number;
  last_token_at: number | null;
};

type MeetingRow = {
  id: string;
  office_slug: string;
  prompt: string;
  target_rounds: number;
};

/**
 * GET /api/notifications
 *
 * Returns four kinds of notifications:
 *  - "tool_approval": agent is requesting permission to use a tool (URGENT — must approve/deny)
 *  - "awaiting_input": agent is blocked on a user reply (URGENT — never auto-dismisses,
 *                      clears only when the run transitions out of awaiting_input)
 *  - "synthesis": war room synthesis finished (click → open war room tab)
 *  - "agent_run": regular agent run finished (click → open agent chat tab)
 *
 * Dismissal for done/synthesis: POST /api/runs/[id]/ack (existing endpoint).
 * Tool approvals: POST /api/tool-approvals/[id]/resolve with action approve/deny.
 * Awaiting_input can't be dismissed — it's active work waiting on the user.
 */
export async function GET() {
  const d = db();

  // Last 24h cutoff for noisy history
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;

  // 1. All runs currently waiting on the user — always surface, regardless of ack state
  const waitingRuns = d
    .prepare(
      `SELECT id, agent_id, office_slug, status, ended_at, started_at, last_token_at
       FROM agent_runs
       WHERE status = 'awaiting_input'
         AND started_at > ?
       ORDER BY COALESCE(last_token_at, started_at) DESC
       LIMIT 20`,
    )
    .all(cutoff) as RunRow[];

  // 2. Unacknowledged completed/failed runs
  const doneRuns = d
    .prepare(
      `SELECT id, agent_id, office_slug, status, ended_at, started_at, last_token_at
       FROM agent_runs
       WHERE status IN ('done', 'error')
         AND acknowledged_at IS NULL
         AND started_at > ?
       ORDER BY COALESCE(ended_at, started_at) DESC
       LIMIT 30`,
    )
    .all(cutoff) as RunRow[];

  // 3. Pending tool approvals (always urgent)
  const toolApprovals = getPendingToolApprovals();

  const allRuns = [...waitingRuns, ...doneRuns];
  if (allRuns.length === 0 && toolApprovals.length === 0) {
    return NextResponse.json({ notifications: [] });
  }

  // Detect synthesis runs (only relevant for done/error; awaiting_input can't be synthesis)
  const runIds = allRuns.map((r) => r.id);
  const placeholders = runIds.map(() => "?").join(",");
  const synthesisMeetings = d
    .prepare(
      `SELECT id, office_slug, prompt, target_rounds, synthesis_run_id
       FROM meetings
       WHERE synthesis_run_id IN (${placeholders})`,
    )
    .all(...runIds) as (MeetingRow & { synthesis_run_id: string })[];
  const synthesisByRunId = new Map<string, MeetingRow>();
  for (const m of synthesisMeetings) {
    synthesisByRunId.set(m.synthesis_run_id, m);
  }

  // Convert tool approvals to notifications (always urgent)
  const toolApprovalNotifications = toolApprovals.map(approval => {
    const agent = getAgent(approval.office_slug, approval.agent_id);
    return {
      kind: "tool_approval" as const,
      approvalId: approval.id,
      runId: approval.run_id,
      at: approval.requested_at,
      officeSlug: approval.office_slug,
      agentId: approval.agent_id,
      agentName: agent?.name ?? approval.agent_id,
      agentRole: agent?.role ?? "",
      toolName: approval.tool_name,
      toolInput: JSON.parse(approval.tool_input),
    };
  });

  const runNotifications = allRuns.map((run) => {
    const agent = getAgent(run.office_slug, run.agent_id);

    if (run.status === "awaiting_input") {
      return {
        kind: "awaiting_input" as const,
        runId: run.id,
        at: run.last_token_at ?? run.started_at,
        officeSlug: run.office_slug,
        agentId: run.agent_id,
        agentName: agent?.name ?? run.agent_id,
        agentRole: agent?.role ?? "",
      };
    }

    const synthMeeting = synthesisByRunId.get(run.id);
    const at = run.ended_at ?? run.started_at;

    if (synthMeeting) {
      return {
        kind: "synthesis" as const,
        runId: run.id,
        status: run.status,
        at,
        officeSlug: synthMeeting.office_slug,
        meetingId: synthMeeting.id,
        promptSnippet:
          synthMeeting.prompt.length > 80
            ? synthMeeting.prompt.slice(0, 80) + "…"
            : synthMeeting.prompt,
      };
    }

    return {
      kind: "agent_run" as const,
      runId: run.id,
      status: run.status,
      at,
      officeSlug: run.office_slug,
      agentId: run.agent_id,
      agentName: agent?.name ?? run.agent_id,
      agentRole: agent?.role ?? "",
    };
  });

  // Combine all notifications - tool approvals first (urgent), then the rest
  const allNotifications = [...toolApprovalNotifications, ...runNotifications];

  return NextResponse.json({ notifications: allNotifications });
}
