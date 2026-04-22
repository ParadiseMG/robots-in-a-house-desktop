import { NextResponse } from "next/server";
import { db, getAllGroupchatMessages } from "@/server/db";

export const dynamic = "force-dynamic";

type MemberRow = { agent_id: string; office_slug: string; assignment_id: string; dropped: number; dropped_at: number | null; drop_reason: string | null };
type GroupchatRow = {
  id: string;
  task_id: string;
  convened_by: string;
  prompt: string;
  convened_at: number;
  target_rounds: number;
  synthesis_run_id: string | null;
  persistent: number;
  pinned_name: string | null;
  status: string;
};
type RunRow = { id: string; status: string; session_id: string | null };
type EventRow = { payload: string };

function extractTailSnippet(runId: string, d: ReturnType<typeof db>): string | null {
  const ev = d
    .prepare(
      `SELECT payload FROM run_events
       WHERE run_id = ? AND kind = 'assistant'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(runId) as EventRow | undefined;
  if (!ev) return null;
  try {
    const parsed = JSON.parse(ev.payload) as { text?: string };
    if (parsed.text) return parsed.text;
  } catch {}
  return null;
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: groupchatId } = await ctx.params;
  if (!groupchatId) {
    return NextResponse.json({ error: "missing groupchat id" }, { status: 400 });
  }
  const d = db();
  const gc = d
    .prepare("SELECT * FROM groupchats WHERE id = ?")
    .get(groupchatId) as GroupchatRow | undefined;
  if (!gc) {
    return NextResponse.json({ error: "groupchat not found" }, { status: 404 });
  }

  const memberRows = d
    .prepare("SELECT agent_id, office_slug, assignment_id, dropped, dropped_at, drop_reason FROM groupchat_members WHERE groupchat_id = ?")
    .all(groupchatId) as MemberRow[];

  const SETTLED = new Set(["done", "error"]);

  const members = memberRows.map((row) => {
    const allRuns = d
      .prepare(
        `SELECT id, status, session_id FROM agent_runs
         WHERE assignment_id = ?
         ORDER BY started_at ASC`,
      )
      .all(row.assignment_id) as RunRow[];

    const runs = allRuns.map((run, idx) => ({
      round: idx + 1,
      runId: run.id,
      status: run.status,
      tailSnippet: extractTailSnippet(run.id, d),
    }));

    const latestRun = allRuns.at(-1);

    return {
      agentId: row.agent_id,
      officeSlug: row.office_slug,
      assignmentId: row.assignment_id,
      runId: latestRun?.id ?? null,
      runStatus: latestRun?.status ?? "idle",
      tailSnippet: runs.at(-1)?.tailSnippet ?? null,
      runs,
      dropped: !!row.dropped,
      droppedAt: row.dropped_at ?? null,
      dropReason: row.drop_reason ?? null,
    };
  });

  let roundsCompleted = 0;
  let currentRound = 0;

  // Only consider active (non-dropped) members for round settlement
  const activeMembers = members.filter((a) => !a.dropped);

  if (activeMembers.length > 0) {
    const maxRounds = Math.max(...members.map((a) => a.runs.length));
    currentRound = maxRounds;

    for (let r = maxRounds; r >= 1; r--) {
      const allSettled = activeMembers.every((a) => {
        const run = a.runs.find((run) => run.round === r);
        return run !== undefined && SETTLED.has(run.status);
      });
      if (allSettled) {
        roundsCompleted = r;
        break;
      }
    }
  }

  const allDone = activeMembers.every((a) => SETTLED.has(a.runStatus) || a.runStatus === "idle");

  let synthesis: { runId: string; status: string; text: string | null } | null = null;
  if (gc.synthesis_run_id) {
    const synRow = d
      .prepare("SELECT id, status FROM agent_runs WHERE id = ?")
      .get(gc.synthesis_run_id) as { id: string; status: string } | undefined;
    if (synRow) {
      synthesis = {
        runId: synRow.id,
        status: synRow.status,
        text: extractTailSnippet(synRow.id, d),
      };
    }
  }

  const userMessages = getAllGroupchatMessages(groupchatId);

  return NextResponse.json({
    groupchatId,
    convenedBy: gc.convened_by,
    prompt: gc.prompt,
    convenedAt: gc.convened_at,
    persistent: !!gc.persistent,
    pinnedName: gc.pinned_name,
    status: gc.status === "idle" ? "idle" : allDone ? "done" : "running",
    roundsCompleted,
    currentRound,
    targetRounds: gc.target_rounds ?? 1,
    members,
    synthesis,
    userMessages,
  });
}
