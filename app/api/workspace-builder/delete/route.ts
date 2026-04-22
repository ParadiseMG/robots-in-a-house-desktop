import { NextResponse } from "next/server";
import { deleteOffice } from "@/lib/config-loader";

export const dynamic = "force-dynamic";

/**
 * POST /api/workspace-builder/delete
 *
 * Deletes an office config and removes it from station.json.
 * Agent workspace directories are retained on disk.
 *
 * Body: { slug: string }
 * Returns: { deleted: true, agents: AgentConfig[] } or error
 */
export async function POST(request: Request) {
  try {
    const { slug } = (await request.json()) as { slug: string };

    if (!slug) {
      return NextResponse.json({ error: "slug is required" }, { status: 400 });
    }

    const deleted = deleteOffice(slug);
    if (!deleted) {
      return NextResponse.json(
        { error: `Office "${slug}" not found` },
        { status: 404 },
      );
    }

    return NextResponse.json({
      deleted: true,
      slug,
      agents: deleted.agents,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
