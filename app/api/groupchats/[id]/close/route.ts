import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { withErrorReporting } from "@/lib/api-error-handler";

export const dynamic = "force-dynamic";

/**
 * POST /api/groupchats/[id]/close — close or idle a groupchat.
 * Persistent groupchats go to "idle" (can be reopened).
 * Ephemeral groupchats go to "closed" (archived).
 */
export const POST = withErrorReporting("POST /api/groupchats/[id]/close", async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id: groupchatId } = await ctx.params;

  const d = db();
  const gc = d
    .prepare("SELECT id, persistent FROM groupchats WHERE id = ?")
    .get(groupchatId) as { id: string; persistent: number } | undefined;

  if (!gc) {
    return NextResponse.json({ error: "groupchat not found" }, { status: 404 });
  }

  const newStatus = gc.persistent ? "idle" : "closed";
  d.prepare("UPDATE groupchats SET status = ? WHERE id = ?").run(newStatus, groupchatId);

  // Log to history
  const prompt = (d.prepare("SELECT prompt FROM groupchats WHERE id = ?").get(groupchatId) as { prompt: string })?.prompt ?? "";
  d.prepare(
    "INSERT INTO groupchat_history (id, groupchat_id, topic, created_at) VALUES (?, ?, ?, ?)",
  ).run(crypto.randomUUID(), groupchatId, prompt.slice(0, 200), Date.now());

  return NextResponse.json({ groupchatId, status: newStatus });
});
