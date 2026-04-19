import { NextResponse } from "next/server";
import { db, getAgent, type AssignmentRow } from "@/server/db";
import { withErrorReporting } from "@/lib/api-error-handler";

export const GET = withErrorReporting("GET /api/assignments", async (req: Request) => {
  const url = new URL(req.url);
  const office = url.searchParams.get("office");
  if (!office) return NextResponse.json({ error: "missing office" }, { status: 400 });

  const rows = db()
    .prepare(
      "SELECT id, task_id, agent_id, desk_id, office_slug, assigned_at, completed_at FROM assignments WHERE office_slug = ? AND completed_at IS NULL ORDER BY assigned_at DESC",
    )
    .all(office) as AssignmentRow[];

  return NextResponse.json({ assignments: rows });
});

export const POST = withErrorReporting("POST /api/assignments", async (req: Request) => {
  const body = (await req.json()) as { taskId?: string; agentId?: string; officeSlug?: string };
  const { taskId, agentId, officeSlug } = body;
  if (!taskId || !agentId || !officeSlug) {
    return NextResponse.json({ error: "missing taskId/agentId/officeSlug" }, { status: 400 });
  }

  const agent = getAgent(officeSlug, agentId);
  if (!agent) return NextResponse.json({ error: "agent not found" }, { status: 404 });

  const d = db();
  const task = d
    .prepare("SELECT id, office_slug, status FROM tasks WHERE id = ?")
    .get(taskId) as { id: string; office_slug: string; status: string } | undefined;
  if (!task) return NextResponse.json({ error: "task not found" }, { status: 404 });
  if (task.office_slug !== officeSlug) {
    return NextResponse.json({ error: "task office mismatch" }, { status: 400 });
  }

  const existing = d
    .prepare("SELECT id FROM assignments WHERE task_id = ? AND completed_at IS NULL LIMIT 1")
    .get(taskId) as { id: string } | undefined;
  if (existing) {
    return NextResponse.json({ error: "task already assigned" }, { status: 409 });
  }

  const assignmentId = crypto.randomUUID();
  const now = Date.now();

  const tx = d.transaction(() => {
    d.prepare(
      "INSERT INTO assignments (id, task_id, agent_id, desk_id, office_slug, assigned_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(assignmentId, taskId, agentId, agent.deskId, officeSlug, now);
    d.prepare("UPDATE tasks SET status = 'assigned' WHERE id = ?").run(taskId);
  });
  tx();

  return NextResponse.json({
    assignment: {
      id: assignmentId,
      task_id: taskId,
      agent_id: agentId,
      desk_id: agent.deskId,
      office_slug: officeSlug,
      assigned_at: now,
      completed_at: null,
    },
  });
});
