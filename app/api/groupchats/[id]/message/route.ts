/**
 * POST /api/groupchats/[id]/message
 * Inject a user message into a running or idle groupchat.
 *
 * Behaviour:
 * - Always stores the message in `groupchat_user_messages`.
 * - If all members are settled (done/error) or have no runs yet:
 *   -> triggers a new round immediately, bundling all pending user messages.
 *   -> marks the messages as delivered.
 * - If any member is still running:
 *   -> queues the message as pending; it will be included in the next round.
 *   -> UNLESS `force: true` is passed — then it cancels running agents and
 *      kicks off a new round immediately.
 *
 * Body: { text: string, force?: boolean }
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
const CONSECUTIVE_ERROR_LIMIT = 2;

type MemberRow = { agent_id: string; office_slug: string; assignment_id: string; dropped: number };
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

function consecutiveErrors(runs: RunRow[]): number {
  let count = 0;
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].status === "error") count++;
    else break;
  }
  return count;
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

    const body = (await req.json()) as { text?: string; message?: string; force?: boolean };
    const text = (body.text ?? body.message ?? "").trim();
    if (!text) {
      return NextResponse.json({ error: "missing text" }, { status: 400 });
    }
    const force = !!body.force;

    const d = db();
    const gc = d
      .prepare("SELECT id, task_id, convened_by, prompt, status FROM groupchats WHERE id = ?")
      .get(groupchatId) as GcRow | undefined;
    if (!gc) {
      return NextResponse.json({ error: "groupchat not found" }, { status: 404 });
    }

    // Store the message
    const sentAt = Date.now();
    const messageId = insertGroupchatMessage(groupchatId, text);

    // Load member run states
    const memberRows = d
      .prepare("SELECT agent_id, office_slug, assignment_id, dropped FROM groupchat_members WHERE groupchat_id = ?")
      .all(groupchatId) as MemberRow[];

    const memberData = memberRows.map((row) => {
      const runs = d
        .prepare(
          "SELECT id, status, session_id FROM agent_runs WHERE assignment_id = ? ORDER BY started_at ASC",
        )
        .all(row.assignment_id) as RunRow[];
      return { ...row, runs, latestRun: runs.at(-1) ?? null, dropped: !!row.dropped };
    });

    // Filter to active members
    const activeMembers = memberData.filter((m) => !m.dropped);

    // If any active member is still running, queue (unless force)
    const runningMembers = activeMembers.filter(
      (m) => m.latestRun !== null && !SETTLED.has(m.latestRun.status),
    );

    if (runningMembers.length > 0 && !force) {
      return NextResponse.json({
        messageId,
        sentAt,
        status: "queued",
        note: "Agents are mid-round. Your message will be included when they finish. Pass force: true to interrupt.",
      });
    }

    // Force mode: mark running agents' current runs as error so we can advance
    if (runningMembers.length > 0 && force) {
      const now = Date.now();
      for (const mem of runningMembers) {
        if (mem.latestRun) {
          d.prepare(
            "UPDATE agent_runs SET status = 'error', error = ?, ended_at = ? WHERE id = ? AND status NOT IN ('done', 'error')",
          ).run("force_interrupted", now, mem.latestRun.id);
        }
      }
    }

    // Auto-drop: check for consecutive errors on active members
    const newlyDropped: string[] = [];
    // Re-read run states after force interruption
    const refreshedData = memberData.map((mem) => {
      if (force && runningMembers.some((rm) => rm.agent_id === mem.agent_id)) {
        const runs = d
          .prepare("SELECT id, status, session_id FROM agent_runs WHERE assignment_id = ? ORDER BY started_at ASC")
          .all(mem.assignment_id) as RunRow[];
        return { ...mem, runs, latestRun: runs.at(-1) ?? null };
      }
      return mem;
    });

    for (const mem of refreshedData.filter((m) => !m.dropped)) {
      if (consecutiveErrors(mem.runs) >= CONSECUTIVE_ERROR_LIMIT) {
        d.prepare(
          "UPDATE groupchat_members SET dropped = 1, dropped_at = ?, drop_reason = ? WHERE groupchat_id = ? AND agent_id = ?",
        ).run(Date.now(), `${CONSECUTIVE_ERROR_LIMIT} consecutive errors`, groupchatId, mem.agent_id);
        mem.dropped = true;
        newlyDropped.push(mem.agent_id);
      }
    }

    const dispatchMembers = refreshedData.filter((m) => !m.dropped);

    // All settled -> trigger a new round now, bundling all pending messages
    const pending = getPendingGroupchatMessages(groupchatId);
    const combinedMessage = pending.map((m) => m.message).join("\n\n---\n\n");

    // Resume groupchat if it was idle
    d.prepare("UPDATE groupchats SET status = 'active' WHERE id = ? AND status = 'idle'").run(groupchatId);

    // Compute the next round number
    const maxRuns = refreshedData.reduce((max, m) => Math.max(max, m.runs.length), 0);
    const newRound = maxRuns + 1;

    // Build peer texts for cross-talk
    const peerTexts = new Map<string, { name: string; role: string; text: string }>();
    for (const mem of refreshedData) {
      if (!mem.latestRun) continue;
      const agent = getAgent(mem.office_slug, mem.agent_id);
      const latestText = mem.dropped ? "(dropped from groupchat)" : getLatestAssistantText(mem.latestRun.id, d);
      peerTexts.set(mem.agent_id, {
        name: agent?.name ?? mem.agent_id,
        role: agent?.role ?? "",
        text: latestText,
      });
    }

    const runResults: Array<{
      agentId: string;
      officeSlug: string;
      assignmentId: string;
      runId: string | null;
      dropped?: boolean;
    }> = [];

    await Promise.all(
      dispatchMembers.map(async (mem) => {
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

    // Include dropped agents in response
    for (const mem of refreshedData.filter((m) => m.dropped)) {
      runResults.push({ agentId: mem.agent_id, officeSlug: mem.office_slug, assignmentId: mem.assignment_id, runId: null, dropped: true });
    }

    // Mark all pending messages as delivered in this round
    markGroupchatMessagesDelivered(
      pending.map((m) => m.id),
      newRound,
    );

    return NextResponse.json({
      messageId,
      sentAt,
      status: "delivered",
      round: newRound,
      runs: runResults,
      forced: force,
      droppedThisRound: newlyDropped,
    });
  },
);
