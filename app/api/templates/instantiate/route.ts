import { NextResponse } from "next/server";
import { instantiateTemplate } from "@/lib/config-loader";
import fs from "node:fs";
import path from "node:path";
import type { StationConfig } from "@/lib/office-types";

export const dynamic = "force-dynamic";

/**
 * POST /api/templates/instantiate
 *
 * Creates a new office from a room template.
 *
 * Body: { templateId, slug, name, accent?, addToStation? }
 *
 * - templateId: which template to use (e.g. "japanese-lounge")
 * - slug: URL-safe office identifier (e.g. "my-team")
 * - name: display name (e.g. "My Team HQ")
 * - accent: optional hex color for station module accent
 * - addToStation: if true, appends the new office as a module in station.json
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { templateId, slug, name, accent, addToStation } = body as {
      templateId: string;
      slug: string;
      name: string;
      accent?: string;
      addToStation?: boolean;
    };

    if (!templateId || !slug || !name) {
      return NextResponse.json(
        { error: "templateId, slug, and name are required" },
        { status: 400 },
      );
    }

    const office = instantiateTemplate(templateId, slug, name, accent);

    // Optionally add to station.json
    if (addToStation !== false) {
      const stationPath = path.join(process.cwd(), "config", "station.json");
      try {
        const station: StationConfig = JSON.parse(
          fs.readFileSync(stationPath, "utf-8"),
        );

        // Find a position that doesn't overlap existing modules.
        // Simple heuristic: place to the right of the rightmost module.
        let maxRight = 0;
        for (const m of station.modules) {
          maxRight = Math.max(maxRight, m.offsetX + 800);
        }

        station.modules.push({
          office: slug,
          offsetX: maxRight + 48,
          offsetY: 0,
          accent: accent ?? office.theme.accent,
        });

        fs.writeFileSync(stationPath, JSON.stringify(station, null, 2) + "\n");
      } catch {
        // No station.json or parse error — skip, office still created
      }
    }

    return NextResponse.json({ office, created: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
