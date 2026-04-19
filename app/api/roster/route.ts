import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { db, queueDepth, activeDelegationsByDelegator, activeDelegationLinks } from "@/server/db";
import type { OfficeConfig } from "@/lib/office-types";

const VALID_SLUGS = new Set(["paradise", "dontcall", "operations", "launchos"]);

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
  if (!officeSlug) {
    return NextResponse.json({ error: "missing office" }, { status: 400 });
  }
  const office = await loadOffice(officeSlug);
  if (!office) return NextResponse.json({ error: "office not found" }, { status: 404 });

  const d = db();

  // Batch query 1: one open assignment per agent in this office
  type AssignRow = { assignment_id: string; agent_id: string; assigned_at: number; task_id: string; title: string; body: string };
  const assignRows = d
    .prepare(
      `SELECT a.id as assignment_id, a.agent_id, a.assigned_at,
              t.id as task_id, t.title, t.body
       FROM assignments a
       JOIN tasks t ON t.id = a.task_id
       WHERE a.office_slug = ? AND a.completed_at IS NULL
       ORDER BY a.assigned_at DESC`,
    )
    .all(officeSlug) as AssignRow[];
  // Keep only the latest per agent (rows already ordered DESC)
  const currentByAgent = new Map<string, AssignRow>();
  for (const row of assignRows) {
    if (!currentByAgent.has(row.agent_id)) currentByAgent.set(row.agent_id, row);
  }

  // Batch query 2: latest run per open assignment
  const assignmentIds = [...currentByAgent.values()].map((r) => r.assignment_id);
  type RunRow = { assignment_id: string; id: string; status: string; acknowledged_at: number | null };
  const runByAssignment = new Map<string, RunRow>();
  if (assignmentIds.length > 0) {
    const placeholders = assignmentIds.map(() => "?").join(",");
    const runRows = d
      .prepare(
        `SELECT assignment_id, id, status, acknowledged_at FROM agent_runs
         WHERE assignment_id IN (${placeholders})
         ORDER BY started_at DESC`,
      )
      .all(...assignmentIds) as RunRow[];
    for (const row of runRows) {
      if (!runByAssignment.has(row.assignment_id)) runByAssignment.set(row.assignment_id, row);
    }
  }

  // Batch query 3: pending input questions for awaiting_input runs
  const awaitingRunIds = [...runByAssignment.values()]
    .filter((r) => r.status === "awaiting_input")
    .map((r) => r.id);
  const inputQuestionByRun = new Map<string, string>();
  if (awaitingRunIds.length > 0) {
    const placeholders = awaitingRunIds.map(() => "?").join(",");
    const eventRows = d
      .prepare(
        `SELECT run_id, payload FROM run_events
         WHERE run_id IN (${placeholders}) AND kind = 'input_request'
         ORDER BY id DESC`,
      )
      .all(...awaitingRunIds) as Array<{ run_id: string; payload: string }>;
    for (const row of eventRows) {
      if (!inputQuestionByRun.has(row.run_id)) {
        try {
          const parsed = JSON.parse(row.payload) as { question?: string };
          if (parsed.question) inputQuestionByRun.set(row.run_id, parsed.question);
        } catch { /* ignore corrupt payload */ }
      }
    }
  }

  // One query for the whole office's active delegations
  const delegationsByAgent = activeDelegationsByDelegator(officeSlug);
  // Pairs: who delegated to whom (for beam lines)
  const delegationLinks = activeDelegationLinks(officeSlug);
  // Map delegateeId → delegatorId for quick lookup per agent
  const delegatedByMap = new Map<string, string>();
  for (const link of delegationLinks) {
    delegatedByMap.set(link.delegateeId, link.delegatorId);
  }

  const entries = office.agents.map((agent) => {
    const current = currentByAgent.get(agent.id);
    const latestRun = current ? runByAssignment.get(current.assignment_id) : undefined;
    const inputQuestion = latestRun ? (inputQuestionByRun.get(latestRun.id) ?? null) : null;

    return {
      agent: {
        id: agent.id,
        deskId: agent.deskId,
        name: agent.name,
        role: agent.role,
        isReal: agent.isReal,
        isHead: agent.isHead ?? false,
        model: agent.model ?? null,
      },
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
      queueDepth: queueDepth(officeSlug, agent.id),
      activeDelegations: delegationsByAgent.get(agent.id) ?? 0,
      delegatedByAgentId: delegatedByMap.get(agent.id) ?? null,
    };
  });

  return NextResponse.json({ officeSlug, entries });
}
