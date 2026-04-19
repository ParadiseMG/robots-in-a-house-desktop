import { NextResponse } from "next/server";
import { db, getAgent, agentIsBusy, enqueuePrompt } from "@/server/db";
import { withErrorReporting } from "@/lib/api-error-handler";

const RUNNER_URL = process.env.RUNNER_URL ?? "http://127.0.0.1:3100";

export const POST = withErrorReporting("POST /api/quick-run", async (req: Request) => {
  const body = (await req.json()) as {
    officeSlug?: string;
    agentId?: string;
    prompt?: string;
    title?: string;
  };
  const { officeSlug, agentId, prompt } = body;
  if (!officeSlug || !agentId || !prompt) {
    return NextResponse.json(
      { error: "missing officeSlug/agentId/prompt" },
      { status: 400 },
    );
  }

  const agent = getAgent(officeSlug, agentId);
  if (!agent) return NextResponse.json({ error: "agent not found" }, { status: 404 });

  const title = body.title?.trim() || prompt.split("\n")[0].slice(0, 80);

  // If the agent is busy, queue the prompt instead of starting immediately
  if (agent.isReal && agentIsBusy(officeSlug, agentId)) {
    const queueId = enqueuePrompt(agentId, officeSlug, title, prompt);
    return NextResponse.json({
      queued: true,
      queueId,
      deskId: agent.deskId,
      isReal: agent.isReal,
    });
  }

  const d = db();
  const taskId = crypto.randomUUID();
  const assignmentId = crypto.randomUUID();
  const now = Date.now();

  const tx = d.transaction(() => {
    d.prepare(
      "INSERT INTO tasks (id, office_slug, title, body, status, created_at) VALUES (?, ?, ?, ?, 'assigned', ?)",
    ).run(taskId, officeSlug, title, prompt, now);
    d.prepare(
      "INSERT INTO assignments (id, task_id, agent_id, desk_id, office_slug, assigned_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(assignmentId, taskId, agentId, agent.deskId, officeSlug, now);
  });
  tx();

  let runId: string | null = null;
  if (agent.isReal) {
    try {
      const res = await fetch(`${RUNNER_URL}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignmentId, agentId, officeSlug, prompt }),
      });
      if (res.ok) {
        const j = (await res.json()) as { runId: string };
        runId = j.runId;
      }
    } catch {
      // assignment still exists even if runner is down
    }
  }

  return NextResponse.json({
    queued: false,
    taskId,
    assignmentId,
    deskId: agent.deskId,
    runId,
    isReal: agent.isReal,
  });
});
