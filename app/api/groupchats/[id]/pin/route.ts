import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { withErrorReporting } from "@/lib/api-error-handler";

export const dynamic = "force-dynamic";

/**
 * POST /api/groupchats/[id]/pin — pin a groupchat (make it persistent).
 * Body: { name: string }
 */
export const POST = withErrorReporting("POST /api/groupchats/[id]/pin", async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id: groupchatId } = await ctx.params;
  const body = (await req.json()) as { name?: string };

  if (!body.name?.trim()) {
    return NextResponse.json({ error: "name is required to pin a groupchat" }, { status: 400 });
  }

  const d = db();
  const result = d
    .prepare("UPDATE groupchats SET persistent = 1, pinned_name = ?, status = CASE WHEN status = 'closed' THEN 'idle' ELSE status END WHERE id = ?")
    .run(body.name.trim(), groupchatId);

  if (result.changes === 0) {
    return NextResponse.json({ error: "groupchat not found" }, { status: 404 });
  }

  return NextResponse.json({ groupchatId, persistent: true, pinnedName: body.name.trim() });
});
