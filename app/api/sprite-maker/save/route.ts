import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { name?: string; imageData?: string };
    const { name, imageData } = body;
    if (!name || !imageData) {
      return NextResponse.json({ error: "missing name or imageData" }, { status: 400 });
    }
    // Sanitize name
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = `premade_${safe}.png`;
    const outPath = path.join(process.cwd(), "public/sprites/characters", filename);

    // Strip data URL prefix if present
    const base64 = imageData.replace(/^data:image\/png;base64,/, "");
    const buf = Buffer.from(base64, "base64");
    await fs.writeFile(outPath, buf);

    return NextResponse.json({ filename, path: `/sprites/characters/${filename}` });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
