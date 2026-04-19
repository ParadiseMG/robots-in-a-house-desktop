import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
  } catch {
    return [];
  }
}

export async function GET() {
  const base = path.join(process.cwd(), "public/sprites/characters/generator");
  return NextResponse.json({
    bodies: listDir(path.join(base, "bodies")),
    eyes: listDir(path.join(base, "eyes")),
    outfits: listDir(path.join(base, "outfits")),
    hairstyles: listDir(path.join(base, "hairstyles")),
    accessories: listDir(path.join(base, "accessories")),
  });
}
