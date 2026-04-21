import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import type { StationConfig } from "@/lib/office-types";
import { withErrorReporting } from "@/lib/api-error-handler";

export const POST = withErrorReporting("POST /api/modules/move", async (req: Request) => {
  const body = (await req.json()) as {
    officeSlug?: unknown;
    offsetX?: unknown;
    offsetY?: unknown;
  };

  const { officeSlug, offsetX, offsetY } = body;

  if (typeof officeSlug !== "string" || !officeSlug) {
    return NextResponse.json({ ok: false, error: "invalid officeSlug" }, { status: 400 });
  }
  if (typeof offsetX !== "number" || typeof offsetY !== "number") {
    return NextResponse.json({ ok: false, error: "offsetX and offsetY must be numbers" }, { status: 400 });
  }

  const stationPath = path.join(process.cwd(), "config", "station.json");

  let station: StationConfig;
  try {
    const raw = await fs.readFile(stationPath, "utf-8");
    station = JSON.parse(raw) as StationConfig;
  } catch {
    return NextResponse.json({ ok: false, error: "station.json not found" }, { status: 500 });
  }

  const mod = station.modules.find((m) => m.office === officeSlug);
  if (!mod) {
    return NextResponse.json({ ok: false, error: "module not found" }, { status: 404 });
  }

  mod.offsetX = offsetX;
  mod.offsetY = offsetY;

  try {
    await fs.writeFile(stationPath, JSON.stringify(station, null, 2) + "\n", "utf-8");
  } catch {
    return NextResponse.json({ ok: false, error: "write failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, module: { office: officeSlug, offsetX, offsetY } });
});
