import { NextResponse } from "next/server";
import { loadAllOffices } from "@/lib/config-loader";

export const dynamic = "force-dynamic";

/**
 * GET /api/offices
 *
 * Returns all office configs discovered from config/*.office.json.
 * Also returns the ordered slug list for display ordering.
 */
export async function GET() {
  const offices = loadAllOffices();
  const slugs = Object.keys(offices);
  return NextResponse.json({ offices, slugs });
}
