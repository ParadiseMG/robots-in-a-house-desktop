/**
 * POST /api/groupchats/[id]/new-chat
 *
 * "New chat" for a groupchat — saves the current conversation to a memory file
 * so Switch (and future rounds) can reference it, then resets all member
 * assignments so the next round starts with fresh sessions (no resume).
 *
 * Steps:
 * 1. Build a summary of the conversation (rounds, agent replies, user messages)
 * 2. Append it to `agent-workspaces/operations/switch/groupchat-memory/<gc-id>.md`
 * 3. Create new assignments for each member (old session_ids won't be resumed)
 * 4. Reset dropped members back to active
 *
 * Returns: { saved: true, memoryPath, newAssignments }
 */

import { NextResponse } from "next/server";
import { db, getAgent } from "@/server/db";
import { withErrorReporting } from "@/lib/api-error-handler";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

type MemberRow = { agent_id: string; office_slug: string; assignment_id: string; dropped: number };
type RunRow = { id: string; status: string; started_at: number; ended_at: number | null };
type EventRow = { payload: string };
type GcRow = {
  id: string;
  task_id: string;
  convened_by: string;
  prompt: string;
  convened_at: number;
  persistent: number;
  pinned_name: string | null;
  status: string;
};
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

function buildMemorySummary(
  gc: GcRow,
  memberRows: MemberRow[],
  d: ReturnType<typeof db>,
): string {
  const lines: string[] = [];
  const date = new Date().toISOString().slice(0, 16).replace("T", " ");
  const name = gc.pinned_name ?? "groupchat";

  lines.push(`## ${name} — session saved ${date}`);
  lines.push("");
  lines.push(`**Topic:** ${gc.prompt}`);
  lines.push(`**Convened by:** ${gc.convened_by}`);
  lines.push("");

  // Collect all runs per member, grouped by round
  const maxRound = memberRows.reduce((max, row) => {
    const count = (
      d.prepare("SELECT COUNT(*) as c FROM agent_runs WHERE assignment_id = ?").get(row.assignment_id) as { c: number }
    ).c;
    return Math.max(max, count);
  }, 0);

  for (let round = 1; round <= maxRound; round++) {
    lines.push(`### Round ${round}`);

    // User messages delivered in this round
    const userMsgs = d
      .prepare(
        "SELECT message FROM groupchat_user_messages WHERE groupchat_id = ? AND delivered_in_round = ? ORDER BY sent_at ASC",
      )
      .all(gc.id, round) as { message: string }[];
    if (userMsgs.length > 0) {
      lines.push("");
      lines.push("**Connor:**");
      for (const msg of userMsgs) {
        lines.push(`> ${msg.message.replace(/\n/g, "\n> ")}`);
      }
    }

    lines.push("");

    for (const mem of memberRows) {
      const agent = getAgent(mem.office_slug, mem.agent_id);
      const agentName = agent?.name ?? mem.agent_id;
      const runs = d
        .prepare(
          "SELECT id, status, started_at, ended_at FROM agent_runs WHERE assignment_id = ? ORDER BY started_at ASC",
        )
        .all(mem.assignment_id) as RunRow[];

      const run = runs[round - 1];
      if (!run) continue;

      const text = extractAssistantText(run.id, d);
      if (run.status === "error") {
        lines.push(`**${agentName}:** (error)`);
      } else if (text) {
        // Truncate long responses to keep memory lean
        const truncated = text.length > 500 ? text.slice(0, 500) + "..." : text;
        lines.push(`**${agentName}:** ${truncated}`);
      } else {
        lines.push(`**${agentName}:** (no reply)`);
      }
    }

    lines.push("");
  }

  // Undelivered user messages (queued but never sent to agents)
  const pending = d
    .prepare(
      "SELECT message FROM groupchat_user_messages WHERE groupchat_id = ? AND delivered_in_round IS NULL ORDER BY sent_at ASC",
    )
    .all(gc.id) as { message: string }[];
  if (pending.length > 0) {
    lines.push("### Undelivered messages");
    for (const msg of pending) {
      lines.push(`> ${msg.message.replace(/\n/g, "\n> ")}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");

  return lines.join("\n");
}

export const POST = withErrorReporting(
  "POST /api/groupchats/[id]/new-chat",
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: groupchatId } = await ctx.params;

    const d = db();
    const gc = d
      .prepare("SELECT * FROM groupchats WHERE id = ?")
      .get(groupchatId) as GcRow | undefined;
    if (!gc) {
      return NextResponse.json({ error: "groupchat not found" }, { status: 404 });
    }

    // Check no agents are running
    const memberRows = d
      .prepare("SELECT agent_id, office_slug, assignment_id, dropped FROM groupchat_members WHERE groupchat_id = ?")
      .all(groupchatId) as MemberRow[];

    const SETTLED = new Set(["done", "error"]);
    const anyRunning = memberRows.some((row) => {
      const latest = d
        .prepare("SELECT status FROM agent_runs WHERE assignment_id = ? ORDER BY started_at DESC LIMIT 1")
        .get(row.assignment_id) as { status: string } | undefined;
      return latest && !SETTLED.has(latest.status);
    });
    if (anyRunning) {
      return NextResponse.json(
        { error: "can't reset while agents are still running" },
        { status: 409 },
      );
    }

    // 1. Build memory summary
    const summary = buildMemorySummary(gc, memberRows, d);

    // 2. Save to groupchat memory file
    const memoryDir = path.join(
      process.cwd(),
      "agent-workspaces",
      "operations",
      "switch",
      "groupchat-memory",
    );
    fs.mkdirSync(memoryDir, { recursive: true });

    const slug = (gc.pinned_name ?? groupchatId)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const memoryPath = path.join(memoryDir, `${slug}.md`);

    // Append to existing file (multiple sessions accumulate)
    fs.appendFileSync(memoryPath, summary, "utf-8");

    // 3. Create new assignments for each member (fresh sessions)
    const now = Date.now();
    const newAssignments: Array<{ agentId: string; oldAssignment: string; newAssignment: string }> = [];

    const tx = d.transaction(() => {
      for (const mem of memberRows) {
        const newAssignmentId = crypto.randomUUID();

        // Create new assignment pointing to same task
        d.prepare(
          "INSERT INTO assignments (id, task_id, agent_id, desk_id, office_slug, assigned_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(
          newAssignmentId,
          gc.task_id,
          mem.agent_id,
          // Look up desk from agent config
          getAgent(mem.office_slug, mem.agent_id)?.deskId ?? `desk-${mem.agent_id}`,
          mem.office_slug,
          now,
        );

        // Update member to point to new assignment
        d.prepare(
          "UPDATE groupchat_members SET assignment_id = ?, dropped = 0, dropped_at = NULL, drop_reason = NULL WHERE groupchat_id = ? AND agent_id = ?",
        ).run(newAssignmentId, groupchatId, mem.agent_id);

        newAssignments.push({
          agentId: mem.agent_id,
          oldAssignment: mem.assignment_id,
          newAssignment: newAssignmentId,
        });
      }

      // Clear old user messages — they're saved in the memory file now
      d.prepare("DELETE FROM groupchat_user_messages WHERE groupchat_id = ?").run(groupchatId);
    });
    tx();

    // 4. Mark groupchat as active (in case it was idle/done)
    d.prepare("UPDATE groupchats SET status = 'active' WHERE id = ?").run(groupchatId);

    // Count rounds from old assignments (before they were replaced)
    const oldRoundCount = memberRows.length > 0
      ? Math.max(
          ...memberRows.map((r) =>
            (d.prepare("SELECT COUNT(*) as c FROM agent_runs WHERE assignment_id = ?").get(r.assignment_id) as { c: number })?.c ?? 0
          ),
        )
      : 0;

    return NextResponse.json({
      saved: true,
      memoryPath: path.relative(process.cwd(), memoryPath),
      roundsSaved: oldRoundCount,
      newAssignments,
    });
  },
);
