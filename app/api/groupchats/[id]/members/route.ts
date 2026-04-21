import { NextResponse } from "next/server";
import { db, getAgent } from "@/server/db";
import { withErrorReporting } from "@/lib/api-error-handler";

export const dynamic = "force-dynamic";

type GroupchatRow = { id: string; persistent: number; status: string; task_id: string };

/**
 * PATCH /api/groupchats/[id]/members — add or remove members from a persistent groupchat.
 * Body: { add?: [{id, officeSlug}], remove?: [agentId] }
 * Only works on persistent groupchats that are idle or active.
 */
export const PATCH = withErrorReporting("PATCH /api/groupchats/[id]/members", async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id: groupchatId } = await ctx.params;
  const body = (await req.json()) as {
    add?: Array<{ id: string; officeSlug: string }>;
    remove?: string[];
  };

  const d = db();
  const gc = d
    .prepare("SELECT id, persistent, status, task_id FROM groupchats WHERE id = ?")
    .get(groupchatId) as GroupchatRow | undefined;

  if (!gc) {
    return NextResponse.json({ error: "groupchat not found" }, { status: 404 });
  }
  if (!gc.persistent) {
    return NextResponse.json({ error: "can only modify members on persistent groupchats" }, { status: 400 });
  }

  const now = Date.now();

  const tx = d.transaction(() => {
    // Remove members
    if (body.remove?.length) {
      const del = d.prepare("DELETE FROM groupchat_members WHERE groupchat_id = ? AND agent_id = ?");
      for (const agentId of body.remove) {
        del.run(groupchatId, agentId);
      }
    }

    // Add members
    if (body.add?.length) {
      const ins = d.prepare(
        "INSERT OR IGNORE INTO groupchat_members (groupchat_id, agent_id, office_slug, assignment_id) VALUES (?, ?, ?, ?)",
      );
      for (const a of body.add) {
        const agent = getAgent(a.officeSlug, a.id);
        if (!agent) continue;
        const assignmentId = `gcassign_${crypto.randomUUID()}`;
        d.prepare(
          "INSERT INTO assignments (id, task_id, agent_id, desk_id, office_slug, assigned_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(assignmentId, gc.task_id, a.id, agent.deskId, a.officeSlug, now);
        ins.run(groupchatId, a.id, a.officeSlug, assignmentId);
      }
    }
  });
  tx();

  // Return updated member list
  const members = d
    .prepare("SELECT agent_id, office_slug FROM groupchat_members WHERE groupchat_id = ?")
    .all(groupchatId) as Array<{ agent_id: string; office_slug: string }>;

  return NextResponse.json({
    groupchatId,
    members: members.map((m) => ({ agentId: m.agent_id, officeSlug: m.office_slug })),
  });
});
