import { NextResponse } from "next/server";
import { db, getAgent, agentIsBusy, enqueuePrompt } from "@/server/db";
import { withErrorReporting } from "@/lib/api-error-handler";

const RUNNER_URL = process.env.RUNNER_URL ?? "http://127.0.0.1:3101";

export const POST = withErrorReporting("POST /api/war-room/run", async (req: Request) => {
  const body = (await req.json()) as {
    officeSlug?: string;
    agentIds?: string[];
    prompt?: string;
    convenedBy?: string;
    targetRounds?: number;
  };
  const { officeSlug, agentIds, prompt, convenedBy, targetRounds } = body;
  if (!officeSlug || !Array.isArray(agentIds) || agentIds.length === 0 || !prompt?.trim()) {
    return NextResponse.json(
      { error: "missing officeSlug/agentIds/prompt" },
      { status: 400 },
    );
  }
  // clamp target rounds to [1, 6]; default 1 (manual / legacy behavior)
  const rounds = Math.max(1, Math.min(6, Math.floor(targetRounds ?? 1)));

  const agents = agentIds.map((id) => getAgent(officeSlug, id));
  if (agents.some((a) => !a)) {
    return NextResponse.json({ error: "one or more agentIds not found in office" }, { status: 400 });
  }
  const realAgents = agents.filter((a) => a!.isReal) as NonNullable<ReturnType<typeof getAgent>>[];

  const d = db();
  const meetingId = `meeting_${crypto.randomUUID()}`;
  const taskId = `wartask_${crypto.randomUUID()}`;
  const now = Date.now();
  const promptTrimmed = prompt.trim();
  const title = `War Room: ${promptTrimmed.split("\n")[0].slice(0, 60)}`;
  const head = convenedBy ?? agentIds[0];

  const attendees: Array<{ agentId: string; assignmentId: string; deskId: string; isReal: boolean }> = [];

  const tx = d.transaction(() => {
    d.prepare(
      "INSERT INTO tasks (id, office_slug, title, body, status, created_at) VALUES (?, ?, ?, ?, 'assigned', ?)",
    ).run(taskId, officeSlug, title, promptTrimmed, now);

    for (const a of agents as NonNullable<ReturnType<typeof getAgent>>[]) {
      const assignmentId = `warassign_${crypto.randomUUID()}`;
      d.prepare(
        "INSERT INTO assignments (id, task_id, agent_id, desk_id, office_slug, assigned_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(assignmentId, taskId, a.id, a.deskId, officeSlug, now);
      attendees.push({ agentId: a.id, assignmentId, deskId: a.deskId, isReal: a.isReal });
    }

    d.prepare(
      "INSERT INTO meetings (id, office_slug, task_id, convened_by, prompt, convened_at, target_rounds) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(meetingId, officeSlug, taskId, head, promptTrimmed, now, rounds);

    const insAttendee = d.prepare(
      "INSERT INTO meeting_attendees (meeting_id, agent_id, assignment_id) VALUES (?, ?, ?)",
    );
    for (const att of attendees) {
      insAttendee.run(meetingId, att.agentId, att.assignmentId);
    }
  });
  tx();

  const runResults: Array<{ agentId: string; assignmentId: string; runId: string | null; queued?: boolean }> = [];
  await Promise.all(
    attendees.map(async (att) => {
      let runId: string | null = null;
      if (att.isReal) {
        // If agent is already running, queue instead of double-dispatching
        if (agentIsBusy(officeSlug, att.agentId)) {
          enqueuePrompt(att.agentId, officeSlug, title, promptTrimmed);
          runResults.push({ agentId: att.agentId, assignmentId: att.assignmentId, runId: null, queued: true });
          return;
        }
        try {
          const res = await fetch(`${RUNNER_URL}/runs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              assignmentId: att.assignmentId,
              agentId: att.agentId,
              officeSlug,
              prompt: promptTrimmed,
            }),
          });
          if (res.ok) {
            const j = (await res.json()) as { runId: string };
            runId = j.runId;
          }
        } catch {
          // assignment row exists even if runner is down
        }
      }
      runResults.push({ agentId: att.agentId, assignmentId: att.assignmentId, runId });
    }),
  );

  return NextResponse.json({
    meetingId,
    taskId,
    convenedAt: now,
    attendees: runResults,
  });
});
