// When this process is launched from within Claude Desktop, the host injects
// env vars (empty ANTHROPIC_API_KEY, a host-scoped CLAUDE_CODE_OAUTH_TOKEN,
// PROVIDER_MANAGED_BY_HOST) that break auth for standalone SDK clients.
// Strip them so the SDK falls back to the keychain OAuth creds from
// `claude setup-token` — which is what we want for the Max subscription path.
if (process.env.ANTHROPIC_API_KEY === "") {
  delete process.env.ANTHROPIC_API_KEY;
}
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST;
delete process.env.CLAUDE_CODE_ENTRYPOINT;

import { createServer } from "node:http";
import { resolve, join } from "node:path";
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  db,
  getAgent,
  getResumeSessionId,
  dequeuePrompt,
  agentIsBusy,
  getDelegationStatus,
  listDelegationsBy,
  upsertRateLimit,
  type AgentRunRow,
} from "./db.js";
import {
  AgentBuilderError,
  createAgent as createAgentImpl,
  isValidOfficeSlug,
} from "../lib/agent-builder.js";

const PORT = Number(process.env.RUNNER_PORT) || 3101;
const ROOT = process.cwd();
const CHANGELOG_PATH = join(ROOT, "data", "changelog.jsonl");

type ChangelogEntry = {
  ts: string;
  agent: string;
  office: string;
  category: "config" | "code" | "architecture" | "workspace";
  summary: string;
  reasoning: string;
  files?: string[];
};

function newId() {
  return crypto.randomUUID();
}

function insertEvent(runId: string, kind: string, payload: unknown) {
  db()
    .prepare(
      "INSERT INTO run_events (run_id, ts, kind, payload) VALUES (?, ?, ?, ?)",
    )
    .run(runId, Date.now(), kind, JSON.stringify(payload));
}

const ALLOWED_RUN_COLUMNS = new Set([
  "status",
  "ended_at",
  "last_token_at",
  "error",
  "session_id",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "acknowledged_at",
]);

function updateRun(runId: string, patch: Partial<AgentRunRow>) {
  const cols = Object.keys(patch).filter((c) => ALLOWED_RUN_COLUMNS.has(c));
  if (cols.length === 0) return;
  const sql = `UPDATE agent_runs SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`;
  db().prepare(sql).run(...cols.map((c) => (patch as Record<string, unknown>)[c]), runId);
}

function addRunTokens(
  runId: string,
  delta: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_creation?: number;
  },
) {
  db()
    .prepare(
      `UPDATE agent_runs SET
         input_tokens          = COALESCE(input_tokens, 0)          + ?,
         output_tokens         = COALESCE(output_tokens, 0)         + ?,
         cache_read_tokens     = COALESCE(cache_read_tokens, 0)     + ?,
         cache_creation_tokens = COALESCE(cache_creation_tokens, 0) + ?,
         last_token_at         = ?
       WHERE id = ?`,
    )
    .run(
      delta.input ?? 0,
      delta.output ?? 0,
      delta.cache_read ?? 0,
      delta.cache_creation ?? 0,
      Date.now(),
      runId,
    );
}

// In-process registry of pending request_input waiters, keyed by runId.
// Single-process runner, so in-memory is fine.
const waiters = new Map<string, (reply: string) => void>();

function makeInputServer(runId: string) {
  return createSdkMcpServer({
    name: "robots-input",
    tools: [
      tool(
        "request_input",
        "Ask Connor (the human) a question and wait for his reply. Use this when you need a decision, clarification, or approval before continuing. Returns his reply as a string.",
        { question: z.string().describe("The question to ask Connor") },
        async (args) => {
          insertEvent(runId, "input_request", { question: args.question });
          updateRun(runId, { status: "awaiting_input" });
          const reply = await new Promise<string>((resolve) => {
            waiters.set(runId, resolve);
          });
          insertEvent(runId, "input_reply", { reply });
          updateRun(runId, { status: "running" });
          return {
            content: [{ type: "text", text: reply }],
          };
        },
      ),
    ],
  });
}

/**
 * Wrap a delegated prompt with a sign-off instruction. The delegator will poll
 * `check_delegation` and read whatever the agent's final assistant message is —
 * so we bake in a closer to make that final message useful regardless of which
 * Claude they are. Applied only to the prompt sent to runAgent; the raw prompt
 * is still stored in tasks.body for the inspector.
 */
function withDelegationSignoff(prompt: string, delegatorAgentId: string): string {
  return `${prompt}

---
(You're handling a delegated task from ${delegatorAgentId}. They will poll check_delegation to see your result. When you finish — whether you completed it, hit a blocker, or decided not to do it — end with a 1–3 sentence summary as your final message. State what you did (or didn't do) and what "done" looks like now. That summary is what they'll read.)`;
}

/**
 * Start a child run on behalf of a delegating agent. Creates task + assignment
 * + run rows (with parentage), then fires runAgent fire-and-forget. If the
 * target is busy, returns `{ queued: true }` after enqueuing. Returns null on
 * unknown target agent.
 */
function startDelegatedRun(params: {
  officeSlug: string;
  targetAgentId: string;
  title: string;
  prompt: string;
  delegatorAgentId: string;
  delegatorRunId: string;
}):
  | { queued: false; runId: string }
  | { queued: true; queueId: string }
  | { error: string } {
  const { officeSlug, targetAgentId, title, prompt } = params;
  const target = getAgent(officeSlug, targetAgentId);
  if (!target) return { error: `no agent '${targetAgentId}' in ${officeSlug}` };
  if (!target.isReal) return { error: `agent '${targetAgentId}' is not a real agent` };

  const wrappedPrompt = withDelegationSignoff(prompt, params.delegatorAgentId);

  if (agentIsBusy(officeSlug, targetAgentId)) {
    // Queued prompts currently don't carry parentage; accept that limitation.
    // When the queue drains, the new run will have no delegated_by — that's OK
    // for MVP (the delegator gets a clear "queued" response). Still wrap the
    // prompt so the queued run at least produces a useful final message.
    const queueId = db().prepare(
      "INSERT INTO prompt_queue (id, agent_id, office_slug, title, prompt, queued_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const id = newId();
    queueId.run(id, targetAgentId, officeSlug, title, wrappedPrompt, Date.now());
    return { queued: true, queueId: id };
  }

  const d = db();
  const taskId = newId();
  const assignmentId = newId();
  const runId = newId();
  const now = Date.now();

  d.transaction(() => {
    d.prepare(
      "INSERT INTO tasks (id, office_slug, title, body, status, created_at) VALUES (?, ?, ?, ?, 'assigned', ?)",
    ).run(taskId, officeSlug, title, prompt, now);
    d.prepare(
      "INSERT INTO assignments (id, task_id, agent_id, desk_id, office_slug, assigned_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(assignmentId, taskId, targetAgentId, target.deskId, officeSlug, now);
    d.prepare(
      `INSERT INTO agent_runs
       (id, assignment_id, agent_id, office_slug, status, started_at,
        delegated_by_agent_id, delegated_by_run_id)
       VALUES (?, ?, ?, ?, 'starting', ?, ?, ?)`,
    ).run(
      runId,
      assignmentId,
      targetAgentId,
      officeSlug,
      now,
      params.delegatorAgentId,
      params.delegatorRunId,
    );
  })();

  insertEvent(runId, "status", {
    status: "starting",
    delegatedBy: params.delegatorAgentId,
    delegatedByRunId: params.delegatorRunId,
  });

  void runAgent({
    runId,
    agentId: targetAgentId,
    officeSlug,
    prompt: wrappedPrompt,
  });

  return { queued: false, runId };
}

/**
 * Delegation MCP server: exposes `delegate_task` bound to the caller's office
 * and runId. The caller can dispatch work to any teammate in the same office.
 * The new run is tagged with `delegated_by_agent_id` / `delegated_by_run_id`
 * so the UI can show satellite dots around the delegator's sprite.
 */
function makeDelegateServer(
  officeSlug: string,
  delegatorAgentId: string,
  delegatorRunId: string,
) {
  return createSdkMcpServer({
    name: "robots-delegate",
    tools: [
      tool(
        "check_delegation",
        `Check on a task you delegated earlier. Pass the runId returned by delegate_task to see if they're done, what they said, or if they're stuck. Omit runId to get a list of your recent delegations. Use this when you want to know whether a dispatched teammate has finished before you move on.`,
        {
          runId: z
            .string()
            .optional()
            .describe(
              "The run id returned by delegate_task. If omitted, returns a list of your recent delegations.",
            ),
        },
        async (args) => {
          if (!args.runId) {
            const list = listDelegationsBy(delegatorAgentId, officeSlug, 10);
            if (list.length === 0) {
              return {
                content: [
                  { type: "text", text: "You haven't delegated anything yet." },
                ],
              };
            }
            const lines = list.map((r) => {
              const dur = r.endedAt
                ? `${Math.round((r.endedAt - r.startedAt) / 1000)}s`
                : `running ${Math.round((Date.now() - r.startedAt) / 1000)}s`;
              return `- ${r.runId.slice(0, 8)}  ${r.agentId.padEnd(10)}  ${r.status.padEnd(14)}  ${dur}  ${r.taskTitle ?? ""}`;
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Your recent delegations (newest first):\n${lines.join("\n")}`,
                },
              ],
            };
          }

          const s = getDelegationStatus(args.runId, delegatorAgentId);
          if (!s) {
            return {
              content: [
                {
                  type: "text",
                  text: `No delegation found with runId ${args.runId} that you dispatched. Either the runId is wrong, or the run was started by someone else.`,
                },
              ],
              isError: true,
            };
          }

          const header = `Run ${s.runId.slice(0, 8)} → ${s.agentId} (${s.taskTitle ?? "untitled"})\nStatus: ${s.status}`;
          if (s.status === "done") {
            const body = s.finalResult ?? s.lastAssistantText ?? "(no output captured)";
            return {
              content: [{ type: "text", text: `${header}\n\nFinal reply:\n${body}` }],
            };
          }
          if (s.status === "error") {
            return {
              content: [
                {
                  type: "text",
                  text: `${header}\nError: ${s.error ?? "unknown"}`,
                },
              ],
            };
          }
          if (s.status === "interrupted") {
            return {
              content: [
                {
                  type: "text",
                  text: `${header}\nThe runner restarted mid-task so this run was interrupted (not a task failure). Re-dispatch if the work still needs to happen.`,
                },
              ],
            };
          }
          if (s.status === "awaiting_input") {
            return {
              content: [
                {
                  type: "text",
                  text: `${header}\nWaiting on Connor for: ${s.pendingQuestion ?? "(question not captured)"}`,
                },
              ],
            };
          }
          // starting / running
          const progress = s.lastAssistantText
            ? `\n\nLast progress line:\n${s.lastAssistantText}`
            : "\n(no assistant output yet)";
          const elapsed = Math.round((Date.now() - s.startedAt) / 1000);
          return {
            content: [
              {
                type: "text",
                text: `${header}\nElapsed: ${elapsed}s${progress}`,
              },
            ],
          };
        },
      ),
      tool(
        "delegate_task",
        `Delegate a task to a teammate in the ${officeSlug} office. Creates a new run on their agent, tagged with you as the delegator. Use this to spawn focused sub-agents (typically Sonnet workers) for specific chunks of work. By default, this BLOCKS until the teammate finishes and returns their final reply as the tool result — so you can dispatch and continue with their answer in hand. Pass \`wait: false\` for true fire-and-forget (you'll get back just a runId and can call check_delegation later). If the target is busy, the task is queued instead.`,
        {
          agentId: z
            .string()
            .min(1)
            .describe(
              "The teammate's agent id (not display name) — e.g. 'deploy', 'designer'. You can only delegate to agents in your own office.",
            ),
          prompt: z
            .string()
            .min(1)
            .describe("The task for the teammate. Be specific about scope, files, and what 'done' looks like."),
          title: z
            .string()
            .optional()
            .describe("Optional short title for the task. Auto-derived from the prompt if omitted."),
          wait: z
            .boolean()
            .optional()
            .describe(
              "Block until the teammate finishes and return their final reply as the tool result (default: true). Set false for fire-and-forget — you'll only get a runId and can poll with check_delegation.",
            ),
        },
        async (args) => {
          const title =
            args.title?.trim() || args.prompt.split("\n")[0].slice(0, 80);
          const shouldWait = args.wait !== false; // default true
          const result = startDelegatedRun({
            officeSlug,
            targetAgentId: args.agentId,
            title,
            prompt: args.prompt,
            delegatorAgentId,
            delegatorRunId,
          });

          if ("error" in result) {
            return {
              content: [{ type: "text", text: `delegate_task failed: ${result.error}` }],
              isError: true,
            };
          }
          if (result.queued) {
            // Queued prompts don't carry parentage, so we can't poll them here.
            // Always return the queued receipt regardless of wait flag.
            return {
              content: [
                {
                  type: "text",
                  text: `${args.agentId} is busy. Queued (id: ${result.queueId}) — they'll pick it up when their current run ends. (Queued runs can't be awaited; re-dispatch when they're free if you need the reply inline.)`,
                },
              ],
            };
          }

          if (!shouldWait) {
            return {
              content: [
                {
                  type: "text",
                  text: `Delegated to ${args.agentId}. Run id: ${result.runId}. They're working on it now (fire-and-forget mode — call check_delegation when you want their reply).`,
                },
              ],
            };
          }

          // Block until child finishes. Poll the DB every 2s up to MAX_WAIT_MS.
          // The delegator's SDK query() loop stays in the tool-call await, so
          // their run stays "running" in the UI while we wait. Child finishing
          // fires the 'done' status event and updateRun flips status to done.
          const MAX_WAIT_MS = 30 * 60 * 1000; // 30 min hard cap
          const POLL_MS = 2000;
          const start = Date.now();
          while (Date.now() - start < MAX_WAIT_MS) {
            await new Promise((r) => setTimeout(r, POLL_MS));
            const s = getDelegationStatus(result.runId, delegatorAgentId);
            if (!s) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Delegation ${result.runId} disappeared unexpectedly — check agent_runs table.`,
                  },
                ],
                isError: true,
              };
            }
            if (s.status === "done") {
              const body = s.finalResult ?? s.lastAssistantText ?? "(no output captured)";
              return {
                content: [
                  {
                    type: "text",
                    text: `${args.agentId} finished (run ${result.runId.slice(0, 8)}):\n\n${body}`,
                  },
                ],
              };
            }
            if (s.status === "error") {
              return {
                content: [
                  {
                    type: "text",
                    text: `${args.agentId} errored (run ${result.runId.slice(0, 8)}): ${s.error ?? "unknown"}`,
                  },
                ],
                isError: true,
              };
            }
            if (s.status === "interrupted") {
              return {
                content: [
                  {
                    type: "text",
                    text: `${args.agentId}'s run (${result.runId.slice(0, 8)}) was interrupted by a runner restart. Re-dispatch if needed.`,
                  },
                ],
              };
            }
            // awaiting_input: surface the pending question so the delegator
            // knows the child is blocked on Connor, not stuck.
            if (s.status === "awaiting_input") {
              return {
                content: [
                  {
                    type: "text",
                    text: `${args.agentId} is blocked waiting on Connor for: "${s.pendingQuestion ?? "(question not captured)"}" (run ${result.runId.slice(0, 8)}). Connor must reply before they can continue. Check back later with check_delegation.`,
                  },
                ],
              };
            }
            // status === 'starting' or 'running' — keep waiting
          }

          // Timeout hit without terminal status
          return {
            content: [
              {
                type: "text",
                text: `Timed out after ${MAX_WAIT_MS / 60000} min waiting on ${args.agentId} (run ${result.runId.slice(0, 8)}). They may still be working — call check_delegation to see current state.`,
              },
            ],
          };
        },
      ),
    ],
  });
}

/**
 * Brand-head MCP server: exposes `create_agent` scoped to the head's own
 * office. The officeSlug is bound here, not a tool argument — so Maestro can
 * only hire for Paradise and Foreman can only hire for Don't Call.
 */
function makeBrandServer(runId: string, officeSlug: string) {
  return createSdkMcpServer({
    name: "robots-brand",
    tools: [
      tool(
        "create_agent",
        `Hire a new teammate for the ${officeSlug} department. Creates a full real agent with its own workspace, a desk placed near yours, and a sprite. The new teammate appears on the office floor immediately and can receive prompts like any other agent. Pick a short distinct name and a concrete role.`,
        {
          name: z.string().min(1).describe("Display name, e.g. 'Juno'"),
          role: z
            .string()
            .min(1)
            .describe("Concrete job title, e.g. 'A&R scout'"),
          sprite: z
            .string()
            .optional()
            .describe(
              "Optional premade sprite filename (e.g. 'premade_05.png'). If omitted, one is auto-picked.",
            ),
          model: z
            .string()
            .optional()
            .describe(
              "Optional Claude model id. Omit to use the SDK default (Sonnet).",
            ),
        },
        async (args) => {
          try {
            if (!isValidOfficeSlug(officeSlug)) {
              throw new AgentBuilderError(
                500,
                `bound officeSlug is invalid: ${officeSlug}`,
              );
            }
            const result = await createAgentImpl({
              officeSlug,
              name: args.name,
              role: args.role,
              sprite: args.sprite,
              model: args.model,
            });
            insertEvent(runId, "tool_use", {
              name: "create_agent_result",
              input: {
                agentId: result.agent.id,
                deskId: result.desk.id,
                sprite: result.agent.visual.premade,
              },
              id: `create-${result.agent.id}`,
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Hired: ${result.agent.name} (${result.agent.role}) as agent id "${result.agent.id}" in ${officeSlug}. Sprite: ${result.agent.visual.premade}. Desk: ${result.desk.id} at (${result.desk.gridX}, ${result.desk.gridY}).`,
                },
              ],
            };
          } catch (err) {
            const message =
              err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text", text: `create_agent failed: ${message}` }],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}

function makeChangelogServer(agentId: string, officeSlug: string) {
  return createSdkMcpServer({
    name: "robots-changelog",
    tools: [
      tool(
        "log_change",
        "Log an environment change to the shared changelog. Call this after making any meaningful change — editing configs, creating/modifying files, changing architecture or roles.",
        {
          category: z.enum(["config", "code", "architecture", "workspace"]).describe("What kind of change: config (office JSON), code (project files), architecture (roles/tools/structure), workspace (your own CLAUDE.md/MEMORY.md)"),
          summary: z.string().describe("One-line summary of what changed"),
          reasoning: z.string().describe("Why this change was made"),
          files: z.array(z.string()).optional().describe("File paths touched, relative to project root"),
        },
        async (args) => {
          const entry: ChangelogEntry = {
            ts: new Date().toISOString(),
            agent: agentId,
            office: officeSlug,
            category: args.category,
            summary: args.summary,
            reasoning: args.reasoning,
            ...(args.files?.length ? { files: args.files } : {}),
          };
          appendFileSync(CHANGELOG_PATH, JSON.stringify(entry) + "\n");
          return { content: [{ type: "text" as const, text: "Logged." }] };
        },
      ),
      tool(
        "query_changelog",
        "Query the shared changelog to see what environment changes have been made recently. Use this before starting complex work to understand recent context.",
        {
          agent: z.string().optional().describe("Filter to entries by this agent ID"),
          office: z.string().optional().describe("Filter to entries from this office slug"),
          category: z.enum(["config", "code", "architecture", "workspace"]).optional().describe("Filter to this category"),
          since: z.string().optional().describe("ISO 8601 date — only entries at or after this timestamp"),
          limit: z.number().int().positive().optional().default(20).describe("Max entries to return (default 20)"),
        },
        async (args) => {
          try {
            if (!existsSync(CHANGELOG_PATH)) {
              return { content: [{ type: "text" as const, text: "[]" }] };
            }
            const raw = readFileSync(CHANGELOG_PATH, "utf8");
            const lines = raw.split("\n").filter((l) => l.trim());
            let entries: ChangelogEntry[] = [];
            for (const line of lines) {
              try { entries.push(JSON.parse(line)); } catch { /* skip corrupt lines */ }
            }
            if (args.agent) entries = entries.filter((e) => e.agent === args.agent);
            if (args.office) entries = entries.filter((e) => e.office === args.office);
            if (args.category) entries = entries.filter((e) => e.category === args.category);
            if (args.since) { const since = args.since; entries = entries.filter((e) => e.ts >= since); }
            entries.reverse();
            entries = entries.slice(0, args.limit);
            return { content: [{ type: "text" as const, text: JSON.stringify(entries, null, 2) }] };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text" as const, text: `query_changelog error: ${message}` }], isError: true };
          }
        },
      ),
    ],
  });
}

async function runAgent(params: {
  runId: string;
  agentId: string;
  officeSlug: string;
  prompt: string;
  resume?: string | null;
}) {
  const { runId, agentId, officeSlug, prompt } = params;
  const agent = getAgent(officeSlug, agentId);
  if (!agent || !agent.isReal) {
    updateRun(runId, {
      status: "error",
      error: "agent not real or not found",
      ended_at: Date.now(),
    });
    insertEvent(runId, "status", { status: "error", reason: "agent not real" });
    return;
  }

  const cwdRel = agent.cwd ?? `agent-workspaces/${officeSlug}/${agentId}`;
  const cwd = resolve(ROOT, cwdRel);
  mkdirSync(cwd, { recursive: true });

  const resume =
    params.resume !== undefined
      ? params.resume
      : getResumeSessionId(officeSlug, agentId);

  updateRun(runId, { status: "running" });
  insertEvent(runId, "status", { status: "running", cwd, resume });

  const inputServer = makeInputServer(runId);
  const extraAllowed: string[] = ["mcp__robots-input__request_input"];
  const mcpServers: Record<string, ReturnType<typeof makeInputServer>> = {
    "robots-input": inputServer,
  };
  mcpServers["robots-changelog"] = makeChangelogServer(agentId, officeSlug);
  extraAllowed.push(
    "mcp__robots-changelog__log_change",
    "mcp__robots-changelog__query_changelog",
  );
  if (agent.isHead) {
    mcpServers["robots-brand"] = makeBrandServer(runId, officeSlug);
    extraAllowed.push("mcp__robots-brand__create_agent");
  }
  // Delegation is available to every real agent — directors, department
  // heads, and ICs alike. Anyone who leads a workstream can spin off helpers.
  mcpServers["robots-delegate"] = makeDelegateServer(
    officeSlug,
    agentId,
    runId,
  );
  extraAllowed.push(
    "mcp__robots-delegate__delegate_task",
    "mcp__robots-delegate__check_delegation",
  );

  try {
    const q = query({
      prompt,
      options: {
        cwd,
        allowedTools: [...(agent.allowedTools ?? []), ...extraAllowed],
        permissionMode: "default",
        settingSources: ["project"],
        mcpServers,
        betas: [],
        settings: { autoCompactWindow: 80_000, disableAutoMode: "disable" },
        ...(agent.model ? { model: agent.model } : {}),
        ...(resume ? { resume } : {}),
      },
    });

    for await (const msg of q) {
      const now = Date.now();
      if (msg.type === "assistant") {
        const blocks = msg.message.content ?? [];
        for (const b of blocks) {
          if (b.type === "text" && b.text) {
            insertEvent(runId, "assistant", { text: b.text });
          } else if (b.type === "tool_use") {
            insertEvent(runId, "tool_use", {
              name: b.name,
              input: b.input,
              id: b.id,
            });
          }
        }
        const u = msg.message.usage;
        addRunTokens(runId, {
          input: u?.input_tokens ?? 0,
          output: u?.output_tokens ?? 0,
          cache_read: u?.cache_read_input_tokens ?? 0,
          cache_creation: u?.cache_creation_input_tokens ?? 0,
        });
        updateRun(runId, { session_id: msg.session_id });
      } else if (msg.type === "result") {
        const u = msg.usage ?? {};
        const inputTokens = (u.input_tokens ?? 0) as number;
        const outputTokens = (u.output_tokens ?? 0) as number;
        const cacheRead = (u.cache_read_input_tokens ?? 0) as number;
        const cacheCreate = (u.cache_creation_input_tokens ?? 0) as number;
        const contextTokens = inputTokens + cacheRead + cacheCreate;
        insertEvent(runId, "status", {
          status: "done",
          result: msg.subtype === "success" ? msg.result : undefined,
          subtype: msg.subtype,
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_read_tokens: cacheRead,
            cache_creation_tokens: cacheCreate,
            context_tokens: contextTokens,
          },
        });
        // Token columns are already accumulated correctly via addRunTokens on
        // each assistant message. Only update terminal fields here to avoid
        // overwriting the accumulated totals with the last-step-only values
        // from the result event.
        updateRun(runId, {
          status: "done",
          ended_at: now,
          session_id: msg.session_id,
        });
      } else if (msg.type === "rate_limit_event") {
        const info = msg.rate_limit_info;
        const key = info.rateLimitType ?? "five_hour";
        upsertRateLimit({
          key,
          utilization: info.utilization ?? 0,
          resetsAt: info.resetsAt,
          status: info.status,
          rateLimitType: info.rateLimitType,
        });
      } else if (msg.type === "system") {
        // skip noise
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    insertEvent(runId, "status", { status: "error", error: message });
    updateRun(runId, {
      status: "error",
      ended_at: Date.now(),
      error: message,
    });
    console.error(`[runner] run ${runId} failed:`, err);
  } finally {
    // If the run ended while still blocked on a waiter, unblock with an empty string
    // so the MCP tool promise resolves (SDK shutdown path).
    const w = waiters.get(runId);
    if (w) {
      waiters.delete(runId);
      w("");
    }

    // Drain prompt queue: if there's a queued prompt for this agent, start it now
    const next = dequeuePrompt(agentId, officeSlug);
    if (next) {
      console.log(`[runner] draining queue for ${agentId} — starting queued prompt: ${next.title}`);
      const d = db();
      const nextTaskId = newId();
      const nextAssignmentId = newId();
      const nextRunId = newId();
      const now = Date.now();
      const ag = getAgent(officeSlug, agentId);
      if (!ag) {
        console.warn(`[runner] agent ${agentId} gone during queue drain, skipping`);
        return;
      }
      const deskId = ag.deskId;

      d.transaction(() => {
        d.prepare(
          "INSERT INTO tasks (id, office_slug, title, body, status, created_at) VALUES (?, ?, ?, ?, 'assigned', ?)",
        ).run(nextTaskId, officeSlug, next.title, next.prompt, now);
        d.prepare(
          "INSERT INTO assignments (id, task_id, agent_id, desk_id, office_slug, assigned_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(nextAssignmentId, nextTaskId, agentId, deskId, officeSlug, now);
        d.prepare(
          "INSERT INTO agent_runs (id, assignment_id, agent_id, office_slug, status, started_at) VALUES (?, ?, ?, ?, 'starting', ?)",
        ).run(nextRunId, nextAssignmentId, agentId, officeSlug, now);
      })();

      insertEvent(nextRunId, "status", { status: "starting" });
      void runAgent({
        runId: nextRunId,
        agentId,
        officeSlug,
        prompt: next.prompt,
      });
    }
  }
}

async function readJson(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/runs") {
      const body = (await readJson(req)) as {
        assignmentId: string;
        agentId: string;
        officeSlug: string;
        prompt: string;
        resume?: string | null;
      };
      if (!body.assignmentId || !body.agentId || !body.officeSlug || !body.prompt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "missing fields" }));
        return;
      }
      if (agentIsBusy(body.officeSlug, body.agentId)) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "agent busy" }));
        return;
      }
      const runId = newId();
      db()
        .prepare(
          `INSERT INTO agent_runs (id, assignment_id, agent_id, office_slug, status, started_at)
           VALUES (?, ?, ?, ?, 'starting', ?)`,
        )
        .run(runId, body.assignmentId, body.agentId, body.officeSlug, Date.now());
      insertEvent(runId, "status", { status: "starting" });

      // Fire-and-forget
      void runAgent({
        runId,
        agentId: body.agentId,
        officeSlug: body.officeSlug,
        prompt: body.prompt,
        resume: body.resume,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ runId }));
      return;
    }

    // POST /runs/:id/reply — resolves a pending request_input waiter
    const replyMatch =
      req.method === "POST" && req.url
        ? req.url.match(/^\/runs\/([^/]+)\/reply$/)
        : null;
    if (replyMatch) {
      const runId = decodeURIComponent(replyMatch[1]);
      const body = (await readJson(req)) as { reply?: string };
      const reply = typeof body.reply === "string" ? body.reply : "";
      const waiter = waiters.get(runId);
      if (!waiter) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "no pending input request" }));
        return;
      }
      waiters.delete(runId);
      waiter(reply);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Returns runs whose ended_at is after ?since=<epoch_ms>, plus any currently
    // awaiting_input. Used by the Electron main process to fire native notifications.
    if (req.method === "GET" && req.url?.startsWith("/runs/recent")) {
      const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
      const since = Number(params.get("since") ?? Date.now() - 30_000);
      const rows = db()
        .prepare(
          `SELECT id, agent_id, office_slug, status, error, started_at, ended_at
           FROM agent_runs
           WHERE (ended_at > ? AND status IN ('done', 'error'))
              OR status = 'awaiting_input'
           ORDER BY started_at DESC
           LIMIT 50`
        )
        .all(since);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(rows));
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  } catch (err) {
    console.error("[runner] handler error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
});

// Touch DB to force migrations at boot
db();
const LOG_DIR = join(ROOT, "data");
mkdirSync(LOG_DIR, { recursive: true });

// Zombie cleanup: mark any in-flight runs as `interrupted` on restart. This is
// distinct from `error` — the work didn't fail, the runner process died. The
// notifications API and the UI both treat interrupted as a silent terminal
// state (no red bubble, no ghost error toast).
{
  const zombies = db()
    .prepare(
      `UPDATE agent_runs SET status = 'interrupted', error = 'runner_restart', ended_at = ?
       WHERE status NOT IN ('done', 'error', 'interrupted')`,
    )
    .run(Date.now());
  if (zombies.changes > 0) {
    console.log(`[runner] marked ${zombies.changes} run(s) as interrupted from previous process`);
  }
}

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[runner] FATAL: port ${PORT} is already in use. Another runner may be running.`);
    console.error(`[runner] Set RUNNER_PORT env var to use a different port.`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`[runner] listening on :${PORT}`);
});
