import { NextResponse } from "next/server";
import { db, getAgent } from "@/server/db";

export const dynamic = "force-dynamic";

const RUNNER_URL = process.env.RUNNER_URL ?? "http://127.0.0.1:3100";

const SETTLED = new Set(["done", "error"]);

type MemberRow = { agent_id: string; office_slug: string; assignment_id: string };
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
    .prepare("SELECT agent_id, office_slug, assignment_id FROM groupchat_members WHERE groupchat_id = ?")
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
    return { agentId: row.agent_id, officeSlug: row.office_slug, assignmentId: row.assignment_id, runs, latestRun };
  });

  // 409 if any member has no settled latest run (unless they have no runs yet — persistent idle)
  const unsettled = memberData.filter(
    (a) => a.latestRun && !SETTLED.has(a.latestRun.status),
  );
  if (unsettled.length > 0) {
    return NextResponse.json(
      { error: `round not settled — ${unsettled.length} member(s) still running`, unsettledAgents: unsettled.map((a) => a.agentId) },
      { status: 409 },
    );
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

  // Build peer texts for cross-talk prompt
  const peerTexts = new Map<string, { name: string; role: string; text: string }>();
  for (const mem of memberData) {
    if (!mem.latestRun) continue;
    const agent = getAgent(mem.officeSlug, mem.agentId);
    const text = getLatestAssistantText(mem.latestRun.id, d);
    peerTexts.set(mem.agentId, {
      name: agent?.name ?? mem.agentId,
      role: agent?.role ?? "",
      text,
    });
  }

  // Combine inline humanMessage (from round body) + queued user messages
  const allHumanMessages: string[] = [];
  if (humanMessage) allHumanMessages.push(humanMessage);
  for (const msg of undeliveredMsgs) {
    allHumanMessages.push(msg.message);
  }

  const runResults: Array<{ agentId: string; officeSlug: string; assignmentId: string; runId: string | null }> = [];

  await Promise.all(
    memberData.map(async (mem) => {
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

  return NextResponse.json({ round: newRound, runs: runResults });
}
