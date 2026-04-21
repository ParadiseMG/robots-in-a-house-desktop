import { NextResponse } from "next/server";
import { db, getAgent } from "@/server/db";

export const dynamic = "force-dynamic";

const RUNNER_URL = process.env.RUNNER_URL ?? "http://127.0.0.1:3101";

const SETTLED = new Set(["done", "error"]);

type MemberRow = { agent_id: string; office_slug: string; assignment_id: string };
type GroupchatRow = {
  id: string;
  task_id: string;
  convened_by: string;
  prompt: string;
  convened_at: number;
  target_rounds: number;
  synthesis_run_id: string | null;
};
type RunRow = { id: string; status: string; session_id: string | null };
type EventRow = { payload: string };

function getLatestAssistantText(runId: string, d: ReturnType<typeof db>): string {
  const ev = d
    .prepare(
      `SELECT payload FROM run_events
       WHERE run_id = ? AND kind = 'assistant'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(runId) as EventRow | undefined;
  if (!ev) return "(no reply)";
  try {
    const parsed = JSON.parse(ev.payload) as { text?: string };
    return parsed.text?.trim() || "(no reply)";
  } catch {
    return "(no reply)";
  }
}

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: groupchatId } = await ctx.params;
  if (!groupchatId) {
    return NextResponse.json({ error: "missing groupchat id" }, { status: 400 });
  }

  const d = db();
  const gc = d
    .prepare("SELECT * FROM groupchats WHERE id = ?")
    .get(groupchatId) as GroupchatRow | undefined;
  if (!gc) {
    return NextResponse.json({ error: "groupchat not found" }, { status: 404 });
  }

  // Idempotency
  if (gc.synthesis_run_id) {
    const existing = d
      .prepare("SELECT id, status FROM agent_runs WHERE id = ?")
      .get(gc.synthesis_run_id) as { id: string; status: string } | undefined;
    if (existing) {
      return NextResponse.json({
        runId: existing.id,
        status: existing.status,
        alreadyRunning: true,
      });
    }
  }

  const memberRows = d
    .prepare("SELECT agent_id, office_slug, assignment_id FROM groupchat_members WHERE groupchat_id = ?")
    .all(groupchatId) as MemberRow[];

  const memberData = memberRows.map((row) => {
    const runs = d
      .prepare(
        `SELECT id, status, session_id FROM agent_runs
         WHERE assignment_id = ?
         ORDER BY started_at ASC`,
      )
      .all(row.assignment_id) as RunRow[];
    const latestRun = runs.at(-1);
    return { agentId: row.agent_id, officeSlug: row.office_slug, assignmentId: row.assignment_id, runs, latestRun };
  });

  const unsettled = memberData.filter(
    (a) => !a.latestRun || !SETTLED.has(a.latestRun.status),
  );
  if (unsettled.length > 0) {
    return NextResponse.json(
      { error: "cannot synthesize until all rounds settle", unsettledAgents: unsettled.map((a) => a.agentId) },
      { status: 409 },
    );
  }

  // Pick synthesizer: convened_by if real, else first real member
  let synthesizer = memberData.find((a) => {
    if (a.agentId !== gc.convened_by) return false;
    const agent = getAgent(a.officeSlug, a.agentId);
    return agent?.isReal;
  });
  if (!synthesizer) {
    synthesizer = memberData.find((a) => {
      const agent = getAgent(a.officeSlug, a.agentId);
      return agent?.isReal;
    });
  }
  if (!synthesizer || !synthesizer.latestRun) {
    return NextResponse.json({ error: "no real member available to synthesize" }, { status: 400 });
  }

  const finalTexts = memberData
    .filter((a) => a.latestRun)
    .map((a) => {
      const agent = getAgent(a.officeSlug, a.agentId);
      const text = getLatestAssistantText(a.latestRun!.id, d);
      return `### ${agent?.name ?? a.agentId} (${agent?.role ?? ""})\n${text}`;
    })
    .join("\n\n");

  const synthPrompt = `The groupchat has concluded. Here are the final positions from each member:\n\n${finalTexts}\n\nNow synthesize the discussion into findings. Structure your response:\n\n**Where we agreed** — shared conclusions across the group\n**Where we diverged** — unresolved disagreements, tradeoffs, open questions\n**Recommended next steps** — concrete actions, owners where obvious\n\nKeep it tight. No preamble. This is the final output for Connor.`;

  const resumeSessionId = synthesizer.latestRun.session_id ?? null;

  let runId: string | null = null;
  try {
    const body: Record<string, unknown> = {
      assignmentId: synthesizer.assignmentId,
      agentId: synthesizer.agentId,
      officeSlug: synthesizer.officeSlug,
      prompt: synthPrompt,
    };
    if (resumeSessionId) body.resume = resumeSessionId;

    const res = await fetch(`${RUNNER_URL}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const j = (await res.json()) as { runId: string };
      runId = j.runId;
    } else {
      const errBody = (await res.json().catch(() => ({}))) as { error?: string };
      return NextResponse.json(
        { error: errBody.error ?? `runner error (${res.status})` },
        { status: 502 },
      );
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  if (!runId) {
    return NextResponse.json({ error: "runner did not return a runId" }, { status: 502 });
  }

  d.prepare("UPDATE groupchats SET synthesis_run_id = ? WHERE id = ?").run(runId, groupchatId);

  return NextResponse.json({
    runId,
    status: "starting",
    synthesizerAgentId: synthesizer.agentId,
  });
}
