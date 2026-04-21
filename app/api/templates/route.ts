import { NextResponse } from "next/server";
import { loadAllTemplates } from "@/lib/config-loader";

export const dynamic = "force-dynamic";

/**
 * GET /api/templates
 *
 * Returns all available room templates from config/templates/*.json.
 * Each template includes: id, name, description, tags, capacity, grid,
 * tile, theme (with premadeRoom), rooms, desks (slots), and preview path.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tag = searchParams.get("tag");

  let templates = loadAllTemplates();

  // Optional tag filter
  if (tag) {
    templates = templates.filter((t) => t.tags.includes(tag));
  }

  return NextResponse.json({
    templates,
    count: templates.length,
  });
}
