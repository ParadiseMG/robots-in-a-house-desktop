import { NextResponse } from "next/server";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

type MeetingRow = {
  id: string;
  office_slug: string;
  convened_by: string;
  prompt: string;
  convened_at: number;
};

type AttendeeRow = { agent_id: string; assignment_id: string };
type RunRow = { id: string; status: string };

const SETTLED = new Set(["done", "error"]);

/**
 * GET /api/war-room — list active (or recent) war rooms.
 * ?status=active  → only meetings with at least one non-settled run (default)
 * ?status=recent  → meetings from the last 24h
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const filter = url.searchParams.get("status") ?? "active";
  const d = db();

  let meetings: MeetingRow[];
  if (filter === "recent") {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    meetings = d
      .prepare("SELECT id, office_slug, convened_by, prompt, convened_at FROM meetings WHERE convened_at > ? ORDER BY convened_at DESC")
      .all(cutoff) as MeetingRow[];
  } else {
    // Active: meetings that have at least one non-settled run
    meetings = d
      .prepare(
        `SELECT DISTINCT m.id, m.office_slug, m.convened_by, m.prompt, m.convened_at
         FROM meetings m
         JOIN meeting_attendees ma ON ma.meeting_id = m.id
         JOIN agent_runs ar ON ar.assignment_id = ma.assignment_id
         WHERE ar.status IN ('starting', 'running', 'awaiting_input')
         ORDER BY m.convened_at DESC`,
      )
      .all() as MeetingRow[];
  }

  const result = meetings.map((m) => {
    const attendees = d
      .prepare("SELECT agent_id, assignment_id FROM meeting_attendees WHERE meeting_id = ?")
      .all(m.id) as AttendeeRow[];

    let hasActive = false;
    let allDone = true;
    const agentStatuses: Array<{ agentId: string; status: string }> = [];

    for (const att of attendees) {
      const latestRun = d
        .prepare("SELECT id, status FROM agent_runs WHERE assignment_id = ? ORDER BY started_at DESC LIMIT 1")
        .get(att.assignment_id) as RunRow | undefined;
      const status = latestRun?.status ?? "queued";
      agentStatuses.push({ agentId: att.agent_id, status });
      if (!SETTLED.has(status)) {
        hasActive = true;
        allDone = false;
      }
    }

    return {
      meetingId: m.id,
      officeSlug: m.office_slug,
      convenedBy: m.convened_by,
      prompt: m.prompt.length > 80 ? m.prompt.slice(0, 80) + "…" : m.prompt,
      convenedAt: m.convened_at,
      status: allDone ? "done" as const : "running" as const,
      attendeeCount: attendees.length,
      agentStatuses,
    };
  });

  return NextResponse.json({ meetings: result });
}
