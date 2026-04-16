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
import { db, getAgent, getResumeSessionId, dequeuePrompt, agentIsBusy, type AgentRunRow } from "./db.js";
import {
  AgentBuilderError,
  createAgent as createAgentImpl,
  isValidOfficeSlug,
} from "../lib/agent-builder.js";

const PORT = 3100;
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

function updateRun(runId: string, patch: Partial<AgentRunRow>) {
  const cols = Object.keys(patch);
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

  if (agentIsBusy(officeSlug, targetAgentId)) {
    // Queued prompts currently don't carry parentage; accept that limitation.
    // When the queue drains, the new run will have no delegated_by — that's OK
    // for MVP (the delegator gets a clear "queued" response).
    const queueId = db().prepare(
      "INSERT INTO prompt_queue (id, agent_id, office_slug, title, prompt, queued_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const id = newId();
    queueId.run(id, targetAgentId, officeSlug, title, prompt, Date.now());
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
    prompt,
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
        "delegate_task",
        `Delegate a task to a teammate in the ${officeSlug} office. Creates a new run on their agent, tagged with you as the delegator. Use this to spawn focused sub-agents (typically Sonnet workers) for specific chunks of work while you stay at a higher altitude. Returns their run id so you can track them. If the target is busy, the task is queued instead.`,
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
        },
        async (args) => {
          const title =
            args.title?.trim() || args.prompt.split("\n")[0].slice(0, 80);
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
            return {
              content: [
                {
                  type: "text",
                  text: `${args.agentId} is busy. Queued (id: ${result.queueId}) — they'll pick it up when their current run ends.`,
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `Delegated to ${args.agentId}. Run id: ${result.runId}. They're working on it now.`,
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

  try {
    const q = query({
      prompt,
      options: {
        cwd,
        allowedTools: [...(agent.allowedTools ?? []), ...extraAllowed],
        permissionMode: "default",
        settingSources: ["project"],
        mcpServers,
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
      const deskId = ag?.deskId ?? "";

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

// Zombie cleanup: mark any in-flight runs as failed on restart
{
  const zombies = db()
    .prepare(
      `UPDATE agent_runs SET status = 'error', error = 'runner_restart', ended_at = ?
       WHERE status NOT IN ('done', 'error')`,
    )
    .run(Date.now());
  if (zombies.changes > 0) {
    console.log(`[runner] cleaned up ${zombies.changes} zombie run(s) from previous process`);
  }
}

server.listen(PORT, () => {
  console.log(`[runner] listening on :${PORT}`);
});
