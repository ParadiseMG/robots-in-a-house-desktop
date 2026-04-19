import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import type { OfficeConfig } from "@/lib/office-types";

const VALID_SLUGS = ["paradise", "dontcall", "operations", "launchos"] as const;
type ValidSlug = (typeof VALID_SLUGS)[number];

function isValidSlug(s: unknown): s is ValidSlug {
  return VALID_SLUGS.includes(s as ValidSlug);
}

export async function POST(req: Request) {
  const body = (await req.json()) as {
    officeSlug?: unknown;
    deskId?: unknown;
    gridX?: unknown;
    gridY?: unknown;
  };

  const { officeSlug, deskId, gridX, gridY } = body;

  if (!isValidSlug(officeSlug)) {
    return NextResponse.json({ ok: false, error: "invalid officeSlug" }, { status: 400 });
  }
  if (typeof deskId !== "string" || !deskId) {
    return NextResponse.json({ ok: false, error: "missing deskId" }, { status: 400 });
  }
  if (typeof gridX !== "number" || typeof gridY !== "number") {
    return NextResponse.json({ ok: false, error: "gridX and gridY must be numbers" }, { status: 400 });
  }

  const configPath = path.join(process.cwd(), "config", `${officeSlug}.office.json`);

  let office: OfficeConfig;
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    office = JSON.parse(raw) as OfficeConfig;
  } catch {
    return NextResponse.json({ ok: false, error: "config not found" }, { status: 500 });
  }

  const { cols, rows } = office.grid;
  if (gridX < 0 || gridX >= cols || gridY < 0 || gridY >= rows) {
    return NextResponse.json({ ok: false, error: "gridX/gridY out of bounds" }, { status: 400 });
  }

  const desk = office.desks.find((d) => d.id === deskId);
  if (!desk) {
    return NextResponse.json({ ok: false, error: "desk not found" }, { status: 404 });
  }

  // Check no other desk already occupies the target cell
  const conflict = office.desks.find(
    (d) => d.id !== deskId && d.gridX === gridX && d.gridY === gridY,
  );
  if (conflict) {
    return NextResponse.json({ ok: false, error: "cell occupied" }, { status: 409 });
  }

  desk.gridX = gridX;
  desk.gridY = gridY;

  try {
    await fs.writeFile(configPath, JSON.stringify(office, null, 2) + "\n", "utf-8");
  } catch {
    return NextResponse.json({ ok: false, error: "write failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, desk: { id: deskId, gridX, gridY } });
}
