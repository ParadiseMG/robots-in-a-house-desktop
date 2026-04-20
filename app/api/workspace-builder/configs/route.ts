import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "@/lib/data-paths";

export const dynamic = "force-dynamic";

export async function GET() {
  const dir = CONFIG_DIR;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".office.json"));
  const configs: Record<string, unknown> = {};
  for (const f of files) {
    const slug = f.replace(".office.json", "");
    try {
      configs[slug] = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
    } catch { /* skip bad files */ }
  }
  return NextResponse.json(configs);
}
