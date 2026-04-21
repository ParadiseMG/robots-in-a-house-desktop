import { NextResponse } from "next/server";
import { db, getAgent, agentIsBusy, enqueuePrompt } from "@/server/db";
import { withErrorReporting } from "@/lib/api-error-handler";

export const dynamic = "force-dynamic";

const RUNNER_URL = process.env.RUNNER_URL ?? "http://127.0.0.1:3100";

const SETTLED = new Set(["done", "error"]);

type MeetingRow = {
  id: string;
  convened_by: string;
  prompt: string;
  convened_at: number;
  persistent: number;
  pinned_name: string | null;
  status: string;
};
type MemberRow = { agent_id: string; office_slug: string; assignment_id: string };
type RunRow = { id: string; status: string };

/**
 * GET /api/groupchats — list groupchats.
 * ?status=active   → groupchats with at least one non-settled run (default)
 * ?status=recent   → groupchats from the last 24h
 * ?status=persistent → all persistent (pinned) groupchats
 */
export const GET = withErrorReporting("GET /api/groupchats", async (req: Request) => {
  const url = new URL(req.url);
  const filter = url.searchParams.get("status") ?? "active";
  const d = db();

  let rows: MeetingRow[];
  if (filter === "persistent") {
    rows = d
      .prepare(
        "SELECT id, convened_by, prompt, convened_at, persistent, pinned_name, status FROM groupchats WHERE persistent = 1 ORDER BY convened_at DESC",
      )
      .all() as MeetingRow[];
  } else if (filter === "recent") {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    rows = d
      .prepare(
        "SELECT id, convened_by, prompt, convened_at, persistent, pinned_name, status FROM groupchats WHERE convened_at > ? ORDER BY convened_at DESC",
      )
      .all(cutoff) as MeetingRow[];
  } else {
    rows = d
      .prepare(
        `SELECT DISTINCT g.id, g.convened_by, g.prompt, g.convened_at, g.persistent, g.pinned_name, g.status
         FROM groupchats g
         JOIN groupchat_members gm ON gm.groupchat_id = g.id
         JOIN agent_runs ar ON ar.assignment_id = gm.assignment_id
         WHERE ar.status IN ('starting', 'running', 'awaiting_input')
         ORDER BY g.convened_at DESC`,
      )
      .all() as MeetingRow[];
  }

  // Also include idle persistent groupchats in active/recent views
  if (filter === "active" || filter === "recent") {
    const persistentIds = new Set(rows.filter((r) => r.persistent).map((r) => r.id));
    const idle = d
      .prepare(
        "SELECT id, convened_by, prompt, convened_at, persistent, pinned_name, status FROM groupchats WHERE persistent = 1 AND status = 'idle'",
      )
      .all() as MeetingRow[];
    for (const r of idle) {
      if (!persistentIds.has(r.id)) rows.push(r);
    }
  }

  const result = rows.map((m) => {
    const members = d
      .prepare("SELECT agent_id, office_slug, assignment_id FROM groupchat_members WHERE groupchat_id = ?")
      .all(m.id) as MemberRow[];

    const agentStatuses: Array<{ agentId: string; officeSlug: string; status: string }> = [];
    for (const mem of members) {
      const latestRun = d
        .prepare("SELECT id, status FROM agent_runs WHERE assignment_id = ? ORDER BY started_at DESC LIMIT 1")
        .get(mem.assignment_id) as RunRow | undefined;
      agentStatuses.push({ agentId: mem.agent_id, officeSlug: mem.office_slug, status: latestRun?.status ?? "idle" });
    }

    const hasActive = agentStatuses.some((a) => !SETTLED.has(a.status) && a.status !== "idle");
    const allDone = agentStatuses.every((a) => SETTLED.has(a.status));

    return {
      groupchatId: m.id,
      convenedBy: m.convened_by,
      prompt: m.prompt.length > 80 ? m.prompt.slice(0, 80) + "\u2026" : m.prompt,
      convenedAt: m.convened_at,
      persistent: !!m.persistent,
      pinnedName: m.pinned_name,
      status: m.status === "idle" ? ("idle" as const) : allDone ? ("done" as const) : ("running" as const),
      memberCount: members.length,
      agentStatuses,
    };
  });

  return NextResponse.json({ groupchats: result });
});

/**
 * POST /api/groupchats — create a new groupchat and kick off round 1.
 * Body: { agents: [{id, officeSlug}], prompt, convenedBy?, targetRounds?, persistent?, pinnedName? }
 */
export const POST = withErrorReporting("POST /api/groupchats", async (req: Request) => {
  const body = (await req.json()) as {
    agents?: Array<{ id: string; officeSlug: string }>;
    prompt?: string;
    convenedBy?: string;
    targetRounds?: number;
    persistent?: boolean;
    pinnedName?: string;
  };
  const { agents, prompt, convenedBy, targetRounds, persistent, pinnedName } = body;
  if (!Array.isArray(agents) || agents.length === 0 || !prompt?.trim()) {
    return NextResponse.json(
      { error: "missing agents/prompt" },
      { status: 400 },
    );
  }

  const rounds = Math.max(1, Math.min(6, Math.floor(targetRounds ?? 1)));

  // Validate all agents exist in their respective offices
  const resolvedAgents = agents.map((a) => {
    const agent = getAgent(a.officeSlug, a.id);
    if (!agent) return null;
    return { ...agent, officeSlug: a.officeSlug };
  });
  if (resolvedAgents.some((a) => !a)) {
    return NextResponse.json({ error: "one or more agents not found" }, { status: 400 });
  }

  const d = db();
  const groupchatId = `gc_${crypto.randomUUID()}`;
  const taskId = `gctask_${crypto.randomUUID()}`;
  const now = Date.now();
  const promptTrimmed = prompt.trim();
  const title = `Groupchat: ${promptTrimmed.split("\n")[0].slice(0, 60)}`;
  const head = convenedBy ?? "connor";

  const memberEntries: Array<{ agentId: string; officeSlug: string; assignmentId: string; deskId: string; isReal: boolean }> = [];

  // Use the first agent's office for the task (or "cross-office")
  const officeSet = new Set(agents.map((a) => a.officeSlug));
  const taskOffice = officeSet.size === 1 ? agents[0].officeSlug : "cross-office";

  const tx = d.transaction(() => {
    d.prepare(
      "INSERT INTO tasks (id, office_slug, title, body, status, created_at) VALUES (?, ?, ?, ?, 'assigned', ?)",
    ).run(taskId, taskOffice, title, promptTrimmed, now);

    for (const a of resolvedAgents as NonNullable<(typeof resolvedAgents)[0]>[]) {
      const assignmentId = `gcassign_${crypto.randomUUID()}`;
      d.prepare(
        "INSERT INTO assignments (id, task_id, agent_id, desk_id, office_slug, assigned_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(assignmentId, taskId, a.id, a.deskId, a.officeSlug, now);
      memberEntries.push({ agentId: a.id, officeSlug: a.officeSlug, assignmentId, deskId: a.deskId, isReal: a.isReal });
    }

    d.prepare(
      "INSERT INTO groupchats (id, task_id, convened_by, prompt, convened_at, target_rounds, persistent, pinned_name, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')",
    ).run(groupchatId, taskId, head, promptTrimmed, now, rounds, persistent ? 1 : 0, pinnedName ?? null);

    const insMember = d.prepare(
      "INSERT INTO groupchat_members (groupchat_id, agent_id, office_slug, assignment_id) VALUES (?, ?, ?, ?)",
    );
    for (const mem of memberEntries) {
      insMember.run(groupchatId, mem.agentId, mem.officeSlug, mem.assignmentId);
    }
  });
  tx();

  // Dispatch runs
  const runResults: Array<{ agentId: string; officeSlug: string; assignmentId: string; runId: string | null; queued?: boolean }> = [];
  await Promise.all(
    memberEntries.map(async (mem) => {
      let runId: string | null = null;
      if (mem.isReal) {
        if (agentIsBusy(mem.officeSlug, mem.agentId)) {
          enqueuePrompt(mem.agentId, mem.officeSlug, title, promptTrimmed);
          runResults.push({ agentId: mem.agentId, officeSlug: mem.officeSlug, assignmentId: mem.assignmentId, runId: null, queued: true });
          return;
        }
        try {
          const res = await fetch(`${RUNNER_URL}/runs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              assignmentId: mem.assignmentId,
              agentId: mem.agentId,
              officeSlug: mem.officeSlug,
              prompt: promptTrimmed,
            }),
          });
          if (res.ok) {
            const j = (await res.json()) as { runId: string };
            runId = j.runId;
          }
        } catch {
          // assignment exists even if runner is down
        }
      }
      runResults.push({ agentId: mem.agentId, officeSlug: mem.officeSlug, assignmentId: mem.assignmentId, runId });
    }),
  );

  return NextResponse.json({
    groupchatId,
    taskId,
    convenedAt: now,
    persistent: !!persistent,
    pinnedName: pinnedName ?? null,
    members: runResults,
  });
});
