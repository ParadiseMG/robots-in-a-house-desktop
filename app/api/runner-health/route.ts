import { NextResponse } from "next/server";
import { checkRunner } from "@/lib/runner-health";

export const dynamic = "force-dynamic";

export async function GET() {
  const status = await checkRunner();
  return NextResponse.json(status, { status: status.ok ? 200 : 503 });
}
