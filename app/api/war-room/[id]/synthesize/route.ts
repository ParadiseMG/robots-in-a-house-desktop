import { NextResponse } from "next/server";
import { db, getAgent } from "@/server/db";

export const dynamic = "force-dynamic";

const RUNNER_URL = process.env.RUNNER_URL ?? "http://127.0.0.1:3101";

const SETTLED = new Set(["done", "error"]);

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

function getLatestAssistantText(runId: string, d: ReturnType<typeof db>): string {
  const ev = d
    .prepare(
      `SELECT payload FROM run_events
       WHERE run_id = ? AND kind = 'assistant'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(runId) as EventRow | undefined;
  if (!ev) return "(no reply)";
  try {
    const parsed = JSON.parse(ev.payload) as { text?: string };
    return parsed.text?.trim() || "(no reply)";
  } catch {
    return "(no reply)";
  }
}

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
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

  // Idempotency — if synthesis already kicked off, just return it
  if (meeting.synthesis_run_id) {
    const existing = d
      .prepare("SELECT id, status FROM agent_runs WHERE id = ?")
      .get(meeting.synthesis_run_id) as { id: string; status: string } | undefined;
    if (existing) {
      return NextResponse.json({
        runId: existing.id,
        status: existing.status,
        alreadyRunning: true,
      });
    }
  }

  const attendeeRows = d
    .prepare("SELECT agent_id, assignment_id FROM meeting_attendees WHERE meeting_id = ?")
    .all(meetingId) as AttendeeRow[];

  // Gather latest runs per attendee and verify all settled
  const attendeeData = attendeeRows.map((row) => {
    const runs = d
      .prepare(
        `SELECT id, status, session_id FROM agent_runs
         WHERE assignment_id = ?
         ORDER BY started_at ASC`,
      )
      .all(row.assignment_id) as RunRow[];
    const latestRun = runs.at(-1);
    return { agentId: row.agent_id, assignmentId: row.assignment_id, runs, latestRun };
  });

  const unsettled = attendeeData.filter(
    (a) => !a.latestRun || !SETTLED.has(a.latestRun.status),
  );
  if (unsettled.length > 0) {
    return NextResponse.json(
      {
        error: "cannot synthesize until all rounds settle",
        unsettledAgents: unsettled.map((a) => a.agentId),
      },
      { status: 409 },
    );
  }

  // Pick the synthesizer: convened_by if real, else first real attendee
  let synthesizer = attendeeData.find((a) => {
    if (a.agentId !== meeting.convened_by) return false;
    const agent = getAgent(meeting.office_slug, a.agentId);
    return agent?.isReal;
  });
  if (!synthesizer) {
    synthesizer = attendeeData.find((a) => {
      const agent = getAgent(meeting.office_slug, a.agentId);
      return agent?.isReal;
    });
  }
  if (!synthesizer || !synthesizer.latestRun) {
    return NextResponse.json(
      { error: "no real attendee available to synthesize" },
      { status: 400 },
    );
  }

  // Build full transcript of final round for the synthesis prompt
  const finalTexts = attendeeData
    .filter((a) => a.latestRun)
    .map((a) => {
      const agent = getAgent(meeting.office_slug, a.agentId);
      const text = getLatestAssistantText(a.latestRun!.id, d);
      return `### ${agent?.name ?? a.agentId} (${agent?.role ?? ""})\n${text}`;
    })
    .join("\n\n");

  const synthPrompt = `The meeting has concluded. Here are the final positions from each attendee:\n\n${finalTexts}\n\nNow synthesize the discussion into findings. Structure your response:\n\n**Where we agreed** — shared conclusions across the group\n**Where we diverged** — unresolved disagreements, tradeoffs, open questions\n**Recommended next steps** — concrete actions, owners where obvious\n\nKeep it tight. No preamble. This is the final output for Connor.`;

  // Resume the synthesizer's session for continuity
  const resumeSessionId = synthesizer.latestRun.session_id ?? null;

  let runId: string | null = null;
  try {
    const body: Record<string, unknown> = {
      assignmentId: synthesizer.assignmentId,
      agentId: synthesizer.agentId,
      officeSlug: meeting.office_slug,
      prompt: synthPrompt,
    };
    if (resumeSessionId) body.resume = resumeSessionId;

    const res = await fetch(`${RUNNER_URL}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const j = (await res.json()) as { runId: string };
      runId = j.runId;
    } else {
      const errBody = (await res.json().catch(() => ({}))) as { error?: string };
      return NextResponse.json(
        { error: errBody.error ?? `runner error (${res.status})` },
        { status: 502 },
      );
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  if (!runId) {
    return NextResponse.json({ error: "runner did not return a runId" }, { status: 502 });
  }

  // Persist synthesis_run_id on the meeting
  d.prepare("UPDATE meetings SET synthesis_run_id = ? WHERE id = ?").run(runId, meetingId);

  return NextResponse.json({
    runId,
    status: "starting",
    synthesizerAgentId: synthesizer.agentId,
  });
}
