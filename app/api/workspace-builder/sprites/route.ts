import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

export async function GET() {
  const dir = path.join(process.cwd(), "public/sprites/characters");
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".png") && (f.startsWith("premade_") || f === "santa_claus.png"))
      .sort();
  } catch {
    return NextResponse.json({ sprites: [] });
  }
  return NextResponse.json({ sprites: files });
}
