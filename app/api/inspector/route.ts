import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { db } from "@/server/db";
import type { OfficeConfig } from "@/lib/office-types";

const VALID_SLUGS = new Set(["paradise", "dontcall", "operations"]);

async function loadOffice(slug: string): Promise<OfficeConfig | null> {
  if (!VALID_SLUGS.has(slug)) return null;
  try {
    const raw = await fs.readFile(
      path.join(process.cwd(), "config", `${slug}.office.json`),
      "utf-8",
    );
    return JSON.parse(raw) as OfficeConfig;
  } catch {
    return null;
  }
}

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const officeSlug = url.searchParams.get("office");
  const deskId = url.searchParams.get("deskId");
  if (!officeSlug || !deskId) {
    return NextResponse.json({ error: "missing office/deskId" }, { status: 400 });
  }
  const office = await loadOffice(officeSlug);
  if (!office) return NextResponse.json({ error: "office not found" }, { status: 404 });

  const desk = office.desks.find((d) => d.id === deskId);
  const agent = office.agents.find((a) => a.deskId === deskId);
  if (!desk || !agent) return NextResponse.json({ error: "desk/agent not found" }, { status: 404 });
  const room = office.rooms.find((r) => r.id === desk.roomId);

  const d = db();
  const current = d
    .prepare(
      `SELECT a.id as assignment_id, a.assigned_at, t.id as task_id, t.title, t.body
       FROM assignments a
       JOIN tasks t ON t.id = a.task_id
       WHERE a.desk_id = ? AND a.office_slug = ? AND a.completed_at IS NULL
       ORDER BY a.assigned_at DESC
       LIMIT 1`,
    )
    .get(deskId, officeSlug) as
    | { assignment_id: string; assigned_at: number; task_id: string; title: string; body: string }
    | undefined;

  const history = d
    .prepare(
      `SELECT a.id, a.assigned_at, a.completed_at, t.title
       FROM assignments a
       JOIN tasks t ON t.id = a.task_id
       WHERE a.desk_id = ? AND a.office_slug = ?
       ORDER BY a.assigned_at DESC
       LIMIT 10`,
    )
    .all(deskId, officeSlug) as Array<{
      id: string;
      assigned_at: number;
      completed_at: number | null;
      title: string;
    }>;

  const latestRun = current
    ? (d
        .prepare(
          `SELECT id, status, acknowledged_at FROM agent_runs
           WHERE assignment_id = ?
           ORDER BY started_at DESC LIMIT 1`,
        )
        .get(current.assignment_id) as
        | { id: string; status: string; acknowledged_at: number | null }
        | undefined)
    : undefined;

  let inputQuestion: string | null = null;
  if (latestRun && latestRun.status === "awaiting_input") {
    const row = d
      .prepare(
        `SELECT payload FROM run_events
         WHERE run_id = ? AND kind = 'input_request'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(latestRun.id) as { payload: string } | undefined;
    if (row) {
      try {
        const parsed = JSON.parse(row.payload) as { question?: string };
        inputQuestion = parsed.question ?? null;
      } catch {
        // ignore
      }
    }
  }

  // Context window snapshot: latest completed run for this agent since last reset
  const lastReset = d
    .prepare(
      `SELECT reset_at FROM session_resets
       WHERE office_slug = ? AND agent_id = ?
       ORDER BY reset_at DESC LIMIT 1`,
    )
    .get(officeSlug, agent.id) as { reset_at: number } | undefined;
  const resetCutoff = lastReset?.reset_at ?? 0;
  const latestTokens = d
    .prepare(
      `SELECT input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, ended_at
       FROM agent_runs
       WHERE office_slug = ? AND agent_id = ?
         AND started_at > ? AND status = 'done'
         AND input_tokens IS NOT NULL
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(officeSlug, agent.id, resetCutoff) as
    | {
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_creation_tokens: number;
        ended_at: number;
      }
    | undefined;
  const CONTEXT_LIMIT = 200_000;
  const contextTokens = latestTokens
    ? latestTokens.input_tokens +
      latestTokens.cache_read_tokens +
      latestTokens.cache_creation_tokens
    : 0;
  const context = latestTokens
    ? {
        tokens: contextTokens,
        limit: CONTEXT_LIMIT,
        pct: Math.min(1, contextTokens / CONTEXT_LIMIT),
        measuredAt: latestTokens.ended_at,
      }
    : null;

  return NextResponse.json({
    agent: {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      isReal: agent.isReal,
      model: agent.model ?? null,
      isHead: agent.isHead ?? false,
    },
    desk: { id: desk.id, facing: desk.facing },
    room: room ? { id: room.id, name: room.name } : null,
    office: { slug: office.slug, name: office.name },
    current: current
      ? {
          assignmentId: current.assignment_id,
          assignedAt: current.assigned_at,
          task: { id: current.task_id, title: current.title, body: current.body },
          runId: latestRun?.id ?? null,
          runStatus: latestRun?.status ?? null,
          acknowledgedAt: latestRun?.acknowledged_at ?? null,
          inputQuestion,
        }
      : null,
    history: history.map((h) => ({
      assignmentId: h.id,
      title: h.title,
      assignedAt: h.assigned_at,
      completedAt: h.completed_at,
    })),
    context,
  });
}
