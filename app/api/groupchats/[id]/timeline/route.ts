import { NextResponse } from "next/server";
import { db, getAgent } from "@/server/db";
import { withErrorReporting } from "@/lib/api-error-handler";

export const dynamic = "force-dynamic";

type MemberRow = { agent_id: string; office_slug: string; assignment_id: string };
type RunRow = { id: string; status: string; started_at: number; ended_at: number | null };
type EventRow = { payload: string };
type UserMsgRow = { id: string; message: string; sent_at: number; delivered_in_round: number | null };

function extractAssistantText(runId: string, d: ReturnType<typeof db>): string | null {
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
    return parsed.text?.trim() || null;
  } catch {
    return null;
  }
}

export type TimelineEntry =
  | {
      type: "agent";
      agentId: string;
      agentName: string;
      agentRole: string;
      officeSlug: string;
      round: number;
      runId: string;
      status: string;
      text: string | null;
      ts: number;
    }
  | {
      type: "user";
      messageId: string;
      text: string;
      ts: number;
      deliveredInRound: number | null;
    }
  | {
      type: "system";
      text: string;
      ts: number;
    };

/**
 * GET /api/groupchats/[id]/timeline — chronological feed of all messages.
 * Returns agent responses, user messages, and system events merged by timestamp.
 */
export const GET = withErrorReporting(
  "GET /api/groupchats/[id]/timeline",
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: groupchatId } = await ctx.params;
    const d = db();

    const gc = d
      .prepare("SELECT id, prompt, convened_at, convened_by FROM groupchats WHERE id = ?")
      .get(groupchatId) as { id: string; prompt: string; convened_at: number; convened_by: string } | undefined;
    if (!gc) {
      return NextResponse.json({ error: "groupchat not found" }, { status: 404 });
    }

    const entries: TimelineEntry[] = [];

    // System entry: groupchat started
    entries.push({
      type: "system",
      text: `Groupchat started by ${gc.convened_by}: ${gc.prompt.length > 120 ? gc.prompt.slice(0, 120) + "..." : gc.prompt}`,
      ts: gc.convened_at,
    });

    // Agent responses — one entry per run per member
    const memberRows = d
      .prepare("SELECT agent_id, office_slug, assignment_id FROM groupchat_members WHERE groupchat_id = ?")
      .all(groupchatId) as MemberRow[];

    for (const mem of memberRows) {
      const agent = getAgent(mem.office_slug, mem.agent_id);
      const runs = d
        .prepare(
          `SELECT id, status, started_at, ended_at FROM agent_runs
           WHERE assignment_id = ?
           ORDER BY started_at ASC`,
        )
        .all(mem.assignment_id) as RunRow[];

      runs.forEach((run, idx) => {
        const text = extractAssistantText(run.id, d);
        entries.push({
          type: "agent",
          agentId: mem.agent_id,
          agentName: agent?.name ?? mem.agent_id,
          agentRole: agent?.role ?? "",
          officeSlug: mem.office_slug,
          round: idx + 1,
          runId: run.id,
          status: run.status,
          text,
          ts: run.ended_at ?? run.started_at,
        });
      });
    }

    // User messages
    const userMsgs = d
      .prepare(
        "SELECT id, message, sent_at, delivered_in_round FROM groupchat_user_messages WHERE groupchat_id = ? ORDER BY sent_at ASC",
      )
      .all(groupchatId) as UserMsgRow[];

    for (const msg of userMsgs) {
      entries.push({
        type: "user",
        messageId: msg.id,
        text: msg.message,
        ts: msg.sent_at,
        deliveredInRound: msg.delivered_in_round,
      });
    }

    // Sort chronologically
    entries.sort((a, b) => a.ts - b.ts);

    return NextResponse.json({ timeline: entries });
  },
);
