import { NextResponse } from "next/server";
import { db, getAgent } from "@/server/db";

export const dynamic = "force-dynamic";

const RUNNER_URL = process.env.RUNNER_URL ?? "http://127.0.0.1:3100";

const SETTLED = new Set(["done", "error"]);

type AttendeeRow = { agent_id: string; assignment_id: string };
type MeetingRow = { id: string; office_slug: string; task_id: string; convened_by: string; prompt: string; convened_at: number };
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

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: meetingId } = await ctx.params;
  if (!meetingId) {
    return NextResponse.json({ error: "missing meeting id" }, { status: 400 });
  }

  // Optional human interjection
  let humanMessage: string | null = null;
  try {
    const body = (await req.json()) as { message?: string };
    if (body.message?.trim()) humanMessage = body.message.trim();
  } catch {
    // no body or invalid JSON — that's fine, proceed without message
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

  // For each attendee, load all runs ordered by started_at
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

  // 409 if any attendee has no settled latest run
  const unsettled = attendeeData.filter(
    (a) => !a.latestRun || !SETTLED.has(a.latestRun.status),
  );
  if (unsettled.length > 0) {
    return NextResponse.json(
      { error: `round not settled — ${unsettled.length} attendee(s) still running`, unsettledAgents: unsettled.map((a) => a.agentId) },
      { status: 409 },
    );
  }

  const newRound = (Math.max(...attendeeData.map((a) => a.runs.length), 0)) + 1;

  // Build peer texts for cross-talk prompt
  const peerTexts = new Map<string, { name: string; role: string; text: string }>();
  for (const att of attendeeData) {
    if (!att.latestRun) continue;
    const agent = getAgent(meeting.office_slug, att.agentId);
    const text = getLatestAssistantText(att.latestRun.id, d);
    peerTexts.set(att.agentId, {
      name: agent?.name ?? att.agentId,
      role: agent?.role ?? "",
      text,
    });
  }

  // Fan out new runs
  const runResults: Array<{ agentId: string; assignmentId: string; runId: string | null }> = [];

  await Promise.all(
    attendeeData.map(async (att) => {
      // Build peer-transcript block (exclude self)
      const peers = [...peerTexts.entries()]
        .filter(([id]) => id !== att.agentId)
        .map(([, p]) => `### ${p.name} (${p.role})\n${p.text}`)
        .join("\n\n");

      const humanBlock = humanMessage
        ? `\n\n### Connor (human)\n${humanMessage}`
        : "";
      const prompt = `The team just shared their latest takes. Here's what your peers said:\n\n${peers}${humanBlock}\n\nReact: where do you agree, where do you push back, what's still unclear? Keep it tight — one paragraph max.`;

      // Determine resume session id
      const sessionId = att.latestRun?.session_id ?? null;

      let runId: string | null = null;
      try {
        const body: Record<string, unknown> = {
          assignmentId: att.assignmentId,
          agentId: att.agentId,
          officeSlug: meeting.office_slug,
          prompt,
        };
        if (sessionId) {
          body.resume = sessionId;
        }

        const res = await fetch(`${RUNNER_URL}/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          const j = (await res.json()) as { runId: string };
          runId = j.runId;
        }
      } catch {
        // runner down — assignment row already exists; will show up on next poll
      }

      runResults.push({ agentId: att.agentId, assignmentId: att.assignmentId, runId });
    }),
  );

  return NextResponse.json({ round: newRound, runs: runResults });
}
