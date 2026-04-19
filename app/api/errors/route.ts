import { NextRequest, NextResponse } from "next/server";
import { queryErrors, ackError, ackAllErrors, errorCount, insertError } from "@/server/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/errors
 *
 * Query params: source, severity, office, agent, since (epoch ms), limit, includeAcked
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;

  const errors = queryErrors({
    source: p.get("source") ?? undefined,
    severity: p.get("severity") ?? undefined,
    officeSlug: p.get("office") ?? undefined,
    agentId: p.get("agent") ?? undefined,
    since: p.has("since") ? Number(p.get("since")) : undefined,
    limit: p.has("limit") ? Number(p.get("limit")) : 50,
    includeAcked: p.get("includeAcked") === "true",
  });

  const count = errorCount();

  return NextResponse.json({ errors, unacknowledgedCount: count });
}

/**
 * POST /api/errors
 *
 * Body: { action: "report" | "ack" | "ack_all", ...data }
 *
 * action=report: { source, severity?, message, stack?, agentId?, officeSlug?, runId?, context? }
 * action=ack: { id }
 * action=ack_all: (no extra fields)
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const action = body.action ?? "report";

  if (action === "ack_all") {
    ackAllErrors();
    return NextResponse.json({ ok: true });
  }

  if (action === "ack") {
    if (!body.id) {
      return NextResponse.json({ error: "missing id" }, { status: 400 });
    }
    ackError(body.id);
    return NextResponse.json({ ok: true });
  }

  // action === "report"
  if (!body.message || !body.source) {
    return NextResponse.json(
      { error: "missing message or source" },
      { status: 400 },
    );
  }

  const id = insertError({
    source: body.source,
    severity: body.severity,
    message: body.message,
    stack: body.stack ?? null,
    agentId: body.agentId ?? null,
    officeSlug: body.officeSlug ?? null,
    runId: body.runId ?? null,
    context: body.context ?? null,
  });

  return NextResponse.json({ id });
}
