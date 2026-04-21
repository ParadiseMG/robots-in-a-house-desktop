/**
 * POST /api/groupchats/[id]/message
 * Inject a user message into a running or idle groupchat.
 *
 * Behaviour:
 * - Always stores the message in `groupchat_user_messages`.
 * - If all members are settled (done/error) or have no runs yet:
 *   → triggers a new round immediately, bundling all pending user messages.
 *   → marks the messages as delivered.
 * - If any member is still running:
 *   → queues the message as pending; it will be included in the next round.
 *
 * Body: { text: string }
 * Returns: { messageId, status: "queued"|"delivered", round?, runs? }
 *
 * GET /api/groupchats/[id]/message
 * Returns all user messages (pending + delivered) for this groupchat.
 */

import { NextResponse } from "next/server";
import {
  db,
  getAgent,
  insertGroupchatMessage,
  getPendingGroupchatMessages,
  getAllGroupchatMessages,
  markGroupchatMessagesDelivered,
} from "@/server/db";
import { withErrorReporting } from "@/lib/api-error-handler";

export const dynamic = "force-dynamic";

const RUNNER_URL = process.env.RUNNER_URL ?? "http://127.0.0.1:3100";
const SETTLED = new Set(["done", "error"]);

type MemberRow = { agent_id: string; office_slug: string; assignment_id: string };
type GcRow = { id: string; task_id: string; convened_by: string; prompt: string; status: string };
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

// ── GET ────────────────────────────────────────────────────────────────────────

export const GET = withErrorReporting(
  "GET /api/groupchats/[id]/message",
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: groupchatId } = await ctx.params;
    const messages = getAllGroupchatMessages(groupchatId);
    return NextResponse.json({ messages });
  },
);

// ── POST ───────────────────────────────────────────────────────────────────────

export const POST = withErrorReporting(
  "POST /api/groupchats/[id]/message",
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: groupchatId } = await ctx.params;

    const body = (await req.json()) as { text?: string; message?: string };
    const text = (body.text ?? body.message ?? "").trim();
    if (!text) {
      return NextResponse.json({ error: "missing text" }, { status: 400 });
    }

    const d = db();
    const gc = d
      .prepare("SELECT id, task_id, convened_by, prompt, status FROM groupchats WHERE id = ?")
      .get(groupchatId) as GcRow | undefined;
    if (!gc) {
      return NextResponse.json({ error: "groupchat not found" }, { status: 404 });
    }

    // Store the message
    const messageId = insertGroupchatMessage(groupchatId, text);

    // Load member run states
    const memberRows = d
      .prepare("SELECT agent_id, office_slug, assignment_id FROM groupchat_members WHERE groupchat_id = ?")
      .all(groupchatId) as MemberRow[];

    const memberData = memberRows.map((row) => {
      const runs = d
        .prepare(
          "SELECT id, status, session_id FROM agent_runs WHERE assignment_id = ? ORDER BY started_at ASC",
        )
        .all(row.assignment_id) as RunRow[];
      return { ...row, runs, latestRun: runs.at(-1) ?? null };
    });

    // If any member is still running, queue and return
    const anyRunning = memberData.some(
      (m) => m.latestRun !== null && !SETTLED.has(m.latestRun.status),
    );
    if (anyRunning) {
      return NextResponse.json({
        messageId,
        status: "queued",
        note: "Agents are mid-round. Your message will be included when they finish.",
      });
    }

    // All settled → trigger a new round now, bundling all pending messages
    const pending = getPendingGroupchatMessages(groupchatId);
    const combinedMessage = pending.map((m) => m.message).join("\n\n---\n\n");

    // Resume groupchat if it was idle
    d.prepare("UPDATE groupchats SET status = 'active' WHERE id = ? AND status = 'idle'").run(groupchatId);

    // Compute the next round number
    const maxRuns = memberData.reduce((max, m) => Math.max(max, m.runs.length), 0);
    const newRound = maxRuns + 1;

    // Build peer texts for cross-talk
    const peerTexts = new Map<string, { name: string; role: string; text: string }>();
    for (const mem of memberData) {
      if (!mem.latestRun) continue;
      const agent = getAgent(mem.office_slug, mem.agent_id);
      const text = getLatestAssistantText(mem.latestRun.id, d);
      peerTexts.set(mem.agent_id, {
        name: agent?.name ?? mem.agent_id,
        role: agent?.role ?? "",
        text,
      });
    }

    const runResults: Array<{
      agentId: string;
      officeSlug: string;
      assignmentId: string;
      runId: string | null;
    }> = [];

    await Promise.all(
      memberData.map(async (mem) => {
        const peers = [...peerTexts.entries()]
          .filter(([id]) => id !== mem.agent_id)
          .map(([, p]) => `### ${p.name} (${p.role})\n${p.text}`)
          .join("\n\n");

        const humanBlock = `\n\n### Connor (human)\n${combinedMessage}`;

        const prompt =
          peerTexts.size > 0
            ? `The team has been discussing. Here's where things stand:\n\n${peers}${humanBlock}\n\nConnor just weighed in — address his message directly, and react to what your peers said. Keep it tight.`
            : combinedMessage;

        const sessionId = mem.latestRun?.session_id ?? null;

        let runId: string | null = null;
        try {
          const runBody: Record<string, unknown> = {
            assignmentId: mem.assignment_id,
            agentId: mem.agent_id,
            officeSlug: mem.office_slug,
            prompt,
          };
          if (sessionId) runBody.resume = sessionId;

          const res = await fetch(`${RUNNER_URL}/runs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(runBody),
          });
          if (res.ok) {
            const j = (await res.json()) as { runId: string };
            runId = j.runId;
          }
        } catch {
          // Runner down — assignment exists, round will show as pending
        }

        runResults.push({
          agentId: mem.agent_id,
          officeSlug: mem.office_slug,
          assignmentId: mem.assignment_id,
          runId,
        });
      }),
    );

    // Mark all pending messages as delivered in this round
    markGroupchatMessagesDelivered(
      pending.map((m) => m.id),
      newRound,
    );

    return NextResponse.json({
      messageId,
      status: "delivered",
      round: newRound,
      runs: runResults,
    });
  },
);
