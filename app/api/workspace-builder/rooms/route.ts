import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

export async function GET() {
  const dir = path.join(process.cwd(), "public/sprites/interiors/premade_rooms");
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
  } catch {
    return NextResponse.json({ grouped: {}, all: [] });
  }

  // Group by brand prefix (paradise_, dontcall_, ops_, etc.)
  const grouped: Record<string, string[]> = {};
  for (const f of files) {
    const prefix = f.split("_")[0] ?? "other";
    if (!grouped[prefix]) grouped[prefix] = [];
    grouped[prefix].push(f);
  }

  return NextResponse.json({ grouped, all: files });
}
