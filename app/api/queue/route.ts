import { NextResponse } from "next/server";
import { db } from "@/server/db";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const officeSlug = url.searchParams.get("office");
  const agentId = url.searchParams.get("agentId");

  if (!officeSlug || !agentId) {
    return NextResponse.json(
      { error: "missing office or agentId" },
      { status: 400 }
    );
  }

  const d = db();
  const queuedPrompts = d
    .prepare(
      `SELECT id, title, prompt, queued_at FROM prompt_queue
       WHERE agent_id = ? AND office_slug = ?
       ORDER BY queued_at ASC`
    )
    .all(agentId, officeSlug) as Array<{
      id: string;
      title: string;
      prompt: string;
      queued_at: number;
    }>;

  return NextResponse.json({ queuedPrompts });
}