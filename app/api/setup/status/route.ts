import { NextResponse } from "next/server";
import fs from "node:fs";
import { CONFIG_DIR } from "@/lib/data-paths";

export const dynamic = "force-dynamic";

/**
 * GET /api/setup/status
 *
 * Returns { needsSetup: boolean } based on whether any office configs exist.
 * The setup wizard uses this, and the main page can redirect first-time users.
 */
export async function GET() {
  const configDir = CONFIG_DIR;
  try {
    const files = fs.readdirSync(configDir).filter((f) => f.endsWith(".office.json"));
    // If no office configs exist at all, the user needs setup
    const needsSetup = files.length === 0;
    return NextResponse.json({ needsSetup, offices: files.length });
  } catch {
    return NextResponse.json({ needsSetup: true, offices: 0 });
  }
}
