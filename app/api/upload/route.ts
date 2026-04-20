import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const dynamic = "force-dynamic";

const DATA_ROOT = process.env.RIAH_DATA_DIR || process.cwd();
const UPLOADS_DIR = path.join(DATA_ROOT, "uploads");

export async function POST(req: Request) {
  try {
    await fs.mkdir(UPLOADS_DIR, { recursive: true });

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "no file" }, { status: 400 });
    }
    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json({ error: "file too large (10MB max)" }, { status: 413 });
    }

    const ext = path.extname(file.name) || "";
    const id = crypto.randomUUID().slice(0, 8);
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filename = `${id}_${safeName}`;
    const filePath = path.join(UPLOADS_DIR, filename);

    const buffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(filePath, buffer);

    return NextResponse.json({
      name: file.name,
      path: `/uploads/${filename}`,
      size: file.size,
      type: file.type,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
