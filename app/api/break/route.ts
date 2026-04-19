import { NextResponse } from "next/server";
import { db, getAgent, getResumeSessionId, agentIsBusy } from "@/server/db";

const RUNNER_URL = process.env.RUNNER_URL ?? "http://127.0.0.1:3101";

const BREAK_PROMPT = `It's break time. Before we wrap this session:

1. Read ./MEMORY.md if it exists.
2. Write (or update) ./MEMORY.md with anything future-you should know to pick up where we left off — current priorities, open threads, recent decisions, people in play. Tight bullets. No preamble.
3. Then reply with one short line: what you took a note of.

Next time we talk you'll start fresh without this conversation history, so the note is how you remember.`;

export async function POST(req: Request) {
  const body = (await req.json()) as {
    officeSlug?: string;
    agentId?: string;
  };
  const { officeSlug, agentId } = body;
  if (!officeSlug || !agentId) {
    return NextResponse.json(
      { error: "missing officeSlug/agentId" },
      { status: 400 },
    );
  }
  const agent = getAgent(officeSlug, agentId);
  if (!agent) return NextResponse.json({ error: "agent not found" }, { status: 404 });
  if (!agent.isReal) {
    return NextResponse.json({ error: "agent is not real" }, { status: 400 });
  }
  if (agentIsBusy(officeSlug, agentId)) {
    return NextResponse.json({ error: "agent is busy" }, { status: 409 });
  }

  const resume = getResumeSessionId(officeSlug, agentId);
  const d = db();
  const taskId = crypto.randomUUID();
  const assignmentId = crypto.randomUUID();
  const now = Date.now();

  const tx = d.transaction(() => {
    d.prepare(
      "INSERT INTO tasks (id, office_slug, title, body, status, created_at) VALUES (?, ?, ?, ?, 'assigned', ?)",
    ).run(taskId, officeSlug, "break time", BREAK_PROMPT, now);
    d.prepare(
      "INSERT INTO assignments (id, task_id, agent_id, desk_id, office_slug, assigned_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(assignmentId, taskId, agentId, agent.deskId, officeSlug, now);
  });
  tx();

  let runId: string | null = null;
  try {
    const res = await fetch(`${RUNNER_URL}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assignmentId,
        agentId,
        officeSlug,
        prompt: BREAK_PROMPT,
        resume,
      }),
    });
    if (res.ok) {
      const j = (await res.json()) as { runId: string };
      runId = j.runId;
    }
  } catch {
    // fall through — assignment still exists
  }

  // Mark reset AFTER the wrap-up run is started. The wrap-up's started_at
  // will be <= now, so its session_id won't be resumed by future runs.
  d.prepare(
    "INSERT INTO session_resets (office_slug, agent_id, reset_at) VALUES (?, ?, ?)",
  ).run(officeSlug, agentId, Date.now());

  return NextResponse.json({
    taskId,
    assignmentId,
    deskId: agent.deskId,
    runId,
    resumedFrom: resume,
  });
}
