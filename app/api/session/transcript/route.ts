import { NextResponse } from "next/server";
import { db } from "@/server/db";

type Message = {
  role: "user" | "assistant";
  ts: number;
  text: string;
  runId?: string;
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const officeSlug = url.searchParams.get("office");
  const agentId = url.searchParams.get("agentId");
  const assignmentId = url.searchParams.get("assignmentId");
  if (!officeSlug || !agentId) {
    return NextResponse.json({ error: "missing office/agentId" }, { status: 400 });
  }

  const d = db();
  let cutoff = 0;
  if (!assignmentId) {
    const lastReset = d
      .prepare(
        `SELECT reset_at FROM session_resets
         WHERE office_slug = ? AND agent_id = ?
         ORDER BY reset_at DESC LIMIT 1`,
      )
      .get(officeSlug, agentId) as { reset_at: number } | undefined;
    cutoff = lastReset?.reset_at ?? 0;
  }

  const runs = assignmentId
    ? (d
        .prepare(
          `SELECT r.id as run_id, r.started_at, r.status, t.title, t.body
           FROM agent_runs r
           JOIN assignments a ON a.id = r.assignment_id
           JOIN tasks t ON t.id = a.task_id
           WHERE r.assignment_id = ?
           ORDER BY r.started_at ASC`,
        )
        .all(assignmentId) as Array<{
          run_id: string;
          started_at: number;
          status: string;
          title: string;
          body: string;
        }>)
    : (d
        .prepare(
          `SELECT r.id as run_id, r.started_at, r.status, t.title, t.body
           FROM agent_runs r
           JOIN assignments a ON a.id = r.assignment_id
           JOIN tasks t ON t.id = a.task_id
           WHERE r.office_slug = ? AND r.agent_id = ? AND r.started_at > ?
           ORDER BY r.started_at ASC`,
        )
        .all(officeSlug, agentId, cutoff) as Array<{
          run_id: string;
          started_at: number;
          status: string;
          title: string;
          body: string;
        }>);

  const messages: Message[] = [];

  for (const run of runs) {
    const userText = run.body?.trim() || run.title;
    messages.push({
      role: "user",
      ts: run.started_at,
      text: userText,
      runId: run.run_id,
    });

    const events = d
      .prepare(
        `SELECT ts, kind, payload FROM run_events
         WHERE run_id = ? AND kind IN ('assistant', 'input_request', 'input_reply')
         ORDER BY id ASC`,
      )
      .all(run.run_id) as Array<{ ts: number; kind: string; payload: string }>;

    for (const ev of events) {
      try {
        const p = JSON.parse(ev.payload) as {
          text?: string;
          question?: string;
          reply?: string;
        };
        if (ev.kind === "assistant" && p.text) {
          messages.push({
            role: "assistant",
            ts: ev.ts,
            text: p.text,
            runId: run.run_id,
          });
        } else if (ev.kind === "input_request" && p.question) {
          messages.push({
            role: "assistant",
            ts: ev.ts,
            text: `❓ ${p.question}`,
            runId: run.run_id,
          });
        } else if (ev.kind === "input_reply" && p.reply) {
          messages.push({
            role: "user",
            ts: ev.ts,
            text: p.reply,
            runId: run.run_id,
          });
        }
      } catch {
        // ignore
      }
    }
  }

  return NextResponse.json({ messages, sessionStart: cutoff });
}
