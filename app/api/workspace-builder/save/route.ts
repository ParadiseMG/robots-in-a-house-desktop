import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import type { OfficeConfig } from "@/lib/office-types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { slug?: string; config?: OfficeConfig };
    const { slug, config } = body;
    if (!slug || !config) {
      return NextResponse.json({ error: "missing slug or config" }, { status: 400 });
    }
    const safe = slug.replace(/[^a-zA-Z0-9_-]/g, "-");
    const filename = `${safe}.office.json`;
    const outPath = path.join(process.cwd(), "config", filename);
    await fs.writeFile(outPath, JSON.stringify(config, null, 2));
    return NextResponse.json({ filename, path: `config/${filename}` });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
