import { NextResponse } from "next/server";
import { loadAllOffices } from "@/lib/config-loader";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

/**
 * GET /api/offices
 *
 * Returns all office configs discovered from config/*.office.json.
 * Also returns station config if station.json exists (for custom layouts).
 */
export async function GET() {
  const offices = loadAllOffices();
  const slugs = Object.keys(offices);

  // Load station.json if it exists (user's custom layout)
  let station = null;
  const stationPath = path.join(process.cwd(), "config", "station.json");
  try {
    if (fs.existsSync(stationPath)) {
      station = JSON.parse(fs.readFileSync(stationPath, "utf-8"));
    }
  } catch {
    // no station config — will use default
  }

  return NextResponse.json({ offices, slugs, station });
}
