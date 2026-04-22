import { NextResponse } from "next/server";
import { db, getAgent, insertGroupchatMessage, markGroupchatMessagesDelivered } from "@/server/db";

export const dynamic = "force-dynamic";

const RUNNER_URL = process.env.RUNNER_URL ?? "http://127.0.0.1:3100";

const SETTLED = new Set(["done", "error"]);
const CONSECUTIVE_ERROR_LIMIT = 2;

type MemberRow = { agent_id: string; office_slug: string; assignment_id: string; dropped: number };
type GroupchatRow = { id: string; task_id: string; convened_by: string; prompt: string; convened_at: number };
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

/** Count how many of the most recent runs ended in error (consecutive, from tail). */
function consecutiveErrors(runs: RunRow[]): number {
  let count = 0;
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].status === "error") count++;
    else break;
  }
  return count;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: groupchatId } = await ctx.params;
  if (!groupchatId) {
    return NextResponse.json({ error: "missing groupchat id" }, { status: 400 });
  }

  let humanMessage: string | null = null;
  try {
    const body = (await req.json()) as { message?: string };
    if (body.message?.trim()) humanMessage = body.message.trim();
  } catch {}

  const d = db();
  const gc = d
    .prepare("SELECT * FROM groupchats WHERE id = ?")
    .get(groupchatId) as GroupchatRow | undefined;
  if (!gc) {
    return NextResponse.json({ error: "groupchat not found" }, { status: 404 });
  }

  // Mark as active again if it was idle (persistent groupchat getting a new round)
  d.prepare("UPDATE groupchats SET status = 'active' WHERE id = ? AND status = 'idle'").run(groupchatId);

  const memberRows = d
    .prepare("SELECT agent_id, office_slug, assignment_id, dropped FROM groupchat_members WHERE groupchat_id = ?")
    .all(groupchatId) as MemberRow[];

  const memberData = memberRows.map((row) => {
    const runs = d
      .prepare(
        `SELECT id, status, session_id FROM agent_runs
         WHERE assignment_id = ?
         ORDER BY started_at ASC`,
      )
      .all(row.assignment_id) as RunRow[];
    const latestRun = runs.at(-1);
    return { agentId: row.agent_id, officeSlug: row.office_slug, assignmentId: row.assignment_id, runs, latestRun, dropped: !!row.dropped };
  });

  // Only consider active (non-dropped) members for settlement check
  const activeMembers = memberData.filter((m) => !m.dropped);

  // 409 if any active member has no settled latest run (unless they have no runs yet)
  const unsettled = activeMembers.filter(
    (a) => a.latestRun && !SETTLED.has(a.latestRun.status),
  );
  if (unsettled.length > 0) {
    return NextResponse.json(
      { error: `round not settled — ${unsettled.length} member(s) still running`, unsettledAgents: unsettled.map((a) => a.agentId) },
      { status: 409 },
    );
  }

  // Auto-drop: check for consecutive errors on active members
  const newlyDropped: string[] = [];
  for (const mem of activeMembers) {
    if (consecutiveErrors(mem.runs) >= CONSECUTIVE_ERROR_LIMIT) {
      d.prepare(
        "UPDATE groupchat_members SET dropped = 1, dropped_at = ?, drop_reason = ? WHERE groupchat_id = ? AND agent_id = ?",
      ).run(Date.now(), `${CONSECUTIVE_ERROR_LIMIT} consecutive errors`, groupchatId, mem.agentId);
      mem.dropped = true;
      newlyDropped.push(mem.agentId);
    }
  }

  // Recalculate active members after drops
  const dispatchMembers = memberData.filter((m) => !m.dropped);

  if (dispatchMembers.length === 0) {
    return NextResponse.json({ error: "all members have been dropped due to errors" }, { status: 422 });
  }

  const newRound = (Math.max(...memberData.map((a) => a.runs.length), 0)) + 1;

  // Collect undelivered user messages (sent since last round)
  type UserMsgRow = { id: string; message: string; sent_at: number };
  const undeliveredMsgs = d
    .prepare(
      "SELECT id, message, sent_at FROM groupchat_user_messages WHERE groupchat_id = ? AND delivered_in_round IS NULL ORDER BY sent_at ASC",
    )
    .all(groupchatId) as UserMsgRow[];

  // Mark them as delivered in this round
  if (undeliveredMsgs.length > 0) {
    const markDelivered = d.prepare(
      "UPDATE groupchat_user_messages SET delivered_in_round = ?, delivered_at = ? WHERE id = ?",
    );
    for (const msg of undeliveredMsgs) {
      markDelivered.run(newRound, Date.now(), msg.id);
    }
  }

  // Build peer texts for cross-talk prompt (include all members for context, even dropped)
  const peerTexts = new Map<string, { name: string; role: string; text: string }>();
  for (const mem of memberData) {
    if (!mem.latestRun) continue;
    const agent = getAgent(mem.officeSlug, mem.agentId);
    const text = mem.dropped ? "(dropped from groupchat)" : getLatestAssistantText(mem.latestRun.id, d);
    peerTexts.set(mem.agentId, {
      name: agent?.name ?? mem.agentId,
      role: agent?.role ?? "",
      text,
    });
  }

  // If Connor sent a message with the round request, store it as a user message
  // so it shows up in the timeline like any other message
  let inlineMessageId: string | null = null;
  if (humanMessage) {
    inlineMessageId = insertGroupchatMessage(groupchatId, humanMessage);
    // Mark it as delivered in this round immediately
    markGroupchatMessagesDelivered([inlineMessageId], newRound);
  }

  // Combine inline humanMessage + queued user messages
  const allHumanMessages: string[] = [];
  if (humanMessage) allHumanMessages.push(humanMessage);
  for (const msg of undeliveredMsgs) {
    allHumanMessages.push(msg.message);
  }

  const runResults: Array<{ agentId: string; officeSlug: string; assignmentId: string; runId: string | null; dropped?: boolean }> = [];

  // Dispatch only to active members
  await Promise.all(
    dispatchMembers.map(async (mem) => {
      const peers = [...peerTexts.entries()]
        .filter(([id]) => id !== mem.agentId)
        .map(([, p]) => `### ${p.name} (${p.role})\n${p.text}`)
        .join("\n\n");

      const humanBlock = allHumanMessages.length > 0
        ? `\n\n### Connor (human)\n${allHumanMessages.join("\n\n")}`
        : "";

      const prompt = peerTexts.size > 0
        ? `The team just shared their latest takes. Here's what your peers said:\n\n${peers}${humanBlock}\n\nReact: where do you agree, where do you push back, what's still unclear? Keep it tight — one paragraph max.`
        : allHumanMessages.join("\n\n") || gc.prompt;

      const sessionId = mem.latestRun?.session_id ?? null;

      let runId: string | null = null;
      try {
        const body: Record<string, unknown> = {
          assignmentId: mem.assignmentId,
          agentId: mem.agentId,
          officeSlug: mem.officeSlug,
          prompt,
        };
        if (sessionId) body.resume = sessionId;

        const res = await fetch(`${RUNNER_URL}/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          const j = (await res.json()) as { runId: string };
          runId = j.runId;
        }
      } catch {}

      runResults.push({ agentId: mem.agentId, officeSlug: mem.officeSlug, assignmentId: mem.assignmentId, runId });
    }),
  );

  // Include dropped agents in response for visibility
  for (const mem of memberData.filter((m) => m.dropped)) {
    runResults.push({ agentId: mem.agentId, officeSlug: mem.officeSlug, assignmentId: mem.assignmentId, runId: null, dropped: true });
  }

  return NextResponse.json({ round: newRound, runs: runResults, droppedThisRound: newlyDropped });
}
