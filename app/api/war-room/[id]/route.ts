import { NextResponse } from "next/server";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

type AttendeeRow = { agent_id: string; assignment_id: string };
type MeetingRow = {
  id: string;
  office_slug: string;
  task_id: string;
  convened_by: string;
  prompt: string;
  convened_at: number;
  target_rounds: number;
  synthesis_run_id: string | null;
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
    if (parsed.text) {
      return parsed.text;
    }
  } catch {
    // ignore
  }
  return null;
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: meetingId } = await ctx.params;
  if (!meetingId) {
    return NextResponse.json({ error: "missing meeting id" }, { status: 400 });
  }
  const d = db();
  const meeting = d
    .prepare("SELECT * FROM meetings WHERE id = ?")
    .get(meetingId) as MeetingRow | undefined;
  if (!meeting) {
    return NextResponse.json({ error: "meeting not found" }, { status: 404 });
  }

  const attendeeRows = d
    .prepare("SELECT agent_id, assignment_id FROM meeting_attendees WHERE meeting_id = ?")
    .all(meetingId) as AttendeeRow[];

  const SETTLED = new Set(["done", "error"]);

  const attendees = attendeeRows.map((row) => {
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
      assignmentId: row.assignment_id,
      // Legacy fields for backwards compat with polling loop
      runId: latestRun?.id ?? null,
      runStatus: latestRun?.status ?? "queued",
      tailSnippet: runs.at(-1)?.tailSnippet ?? null,
      runs,
    };
  });

  // roundsCompleted: highest round number where every attendee has a settled run
  // currentRound: highest round number seen across any attendee
  let roundsCompleted = 0;
  let currentRound = 0;

  if (attendees.length > 0) {
    const maxRounds = Math.max(...attendees.map((a) => a.runs.length));
    currentRound = maxRounds;

    for (let r = maxRounds; r >= 1; r--) {
      const allSettled = attendees.every((a) => {
        const run = a.runs.find((run) => run.round === r);
        return run !== undefined && SETTLED.has(run.status);
      });
      if (allSettled) {
        roundsCompleted = r;
        break;
      }
    }
  }

  const allDone = attendees.every((a) => SETTLED.has(a.runStatus));

  // Load synthesis run, if any
  let synthesis: {
    runId: string;
    status: string;
    text: string | null;
  } | null = null;
  if (meeting.synthesis_run_id) {
    const synRow = d
      .prepare("SELECT id, status FROM agent_runs WHERE id = ?")
      .get(meeting.synthesis_run_id) as
      | { id: string; status: string }
      | undefined;
    if (synRow) {
      synthesis = {
        runId: synRow.id,
        status: synRow.status,
        text: extractTailSnippet(synRow.id, d),
      };
    }
  }

  return NextResponse.json({
    meetingId,
    officeSlug: meeting.office_slug,
    convenedBy: meeting.convened_by,
    prompt: meeting.prompt,
    convenedAt: meeting.convened_at,
    status: allDone ? "done" : "running",
    roundsCompleted,
    currentRound,
    targetRounds: meeting.target_rounds ?? 1,
    attendees,
    synthesis,
  });
}
