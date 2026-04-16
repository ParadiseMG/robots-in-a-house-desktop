# Building robots-in-a-house

Full builder brief. A new agent (human or AI) should be able to pick up work from this doc alone.

---

## What this app is

A top-down pixel-art "office" where Connor works alongside AI agents rendered as sprites. Two offices: **Paradise** (music events brand, Austin TX) and **Don't Call** (SMS service for tradespeople). Click an agent → inspector opens on the right. Type in the chat footer → the agent runs as a real Claude Agent SDK session. Runs within a session thread via `resume` (SDK), so agents remember prior conversation until Connor hits "break time" (which triggers a MEMORY.md write and a fresh session).

Core loop: drop a task on a desk *or* chat with a sprite → SDK `query()` spins up with the agent's persona + cwd + tools → events stream to DB → UI tails via SSE → done/awaiting_input indicators pop above the sprite.

---

## Two-process architecture

| Process | Port | Command | Purpose |
|---------|------|---------|---------|
| Next.js (Turbopack) | 3000 | `next dev` | UI, API routes, SSR |
| Agent Runner (tsx watch) | 3100 | `tsx watch server/agent-runner.ts` | Long-lived SDK queries, blocking MCP tools, run events |

Both start together with `npm run dev` (via `concurrently`). The Next API routes proxy run lifecycle calls to the runner over HTTP (`RUNNER_URL` env, defaults to `http://127.0.0.1:3100`).

**Why two processes?** SDK queries are long-running (minutes). Keeping them in the Next server would tie up request handlers and fight with dev-mode HMR. The runner owns the SDK lifecycle; Next owns the DB reads + UI.

---

## Prerequisites & first run

```bash
npm install
npm run dev
```

That's it — DB auto-migrates and auto-seeds from `server/db.ts` on first boot. SQLite file lands at `data/robots.db`. The `data/` dir is created if missing.

**Claude credentials:** The Agent SDK picks up auth the same way `claude` CLI does — either `ANTHROPIC_API_KEY` env, or a logged-in `claude` session. No `.env` is committed; if the runner errors with auth, run `claude` once to log in on this machine.

**Node version:** No `.nvmrc`, but LimeZu / Next 16 / better-sqlite3 all expect Node 20+.

---

## Repo map

```
app/
  page.tsx                  — root UI: office switcher, canvas, inspector, prompt bar, palette
  api/
    roster/                 — GET: per-agent current task + run status + ack + input question
    inspector/              — GET: full inspector payload (agent, current, history, context)
    tasks/                  — GET/POST: task tray CRUD
    assignments/            — POST: drop a task on a desk (task + assignment)
    runs/                   — POST: proxy to runner /runs
    runs/[id]/stream/       — SSE: live tail of a run's events
    runs/[id]/reply/        — POST: answer an `awaiting_input` blocker
    runs/[id]/ack/          — POST: mark a `done` run acknowledged
    quick-run/              — POST: one-shot task+assignment+run (chat + prompt bar path)
    session/transcript/     — GET: chat messages for current session or a specific assignment
    break/                  — POST: trigger MEMORY.md write + mark session_resets row
    desks/move/             — POST: persist a drag-to-reposition to the office JSON on disk
    usage/                  — GET: rolling 5h token usage
components/
  pixi/Office.tsx           — PixiJS canvas, sprite rendering, drag, indicators, bob ticker
  inspector/AgentInspector.tsx — right panel: agent info, chat view (session + historical), footer input
  roster/RosterTray.tsx     — right panel when nothing selected; director pinned top
  sprite-bubble/SpriteBubble.tsx — DOM overlay above a sprite (task or reply mode)
  prompt-bar/PromptBar.tsx  — bottom @-mention task entry
  palette/CommandPalette.tsx — ⌘K: switch office, focus agent
  usage/UsageTracker.tsx    — 5h rolling token budget bar
  tray/TaskTray.tsx         — (unused currently; tasks are drag-dropped from palette/bar)
lib/
  office-types.ts           — shared TS types: OfficeConfig, Agent, Desk, IndicatorKind
  sprite-loader.ts          — LimeZu tilesheet slicer + premade room loader (cached)
server/
  db.ts                     — better-sqlite3 setup, migrations, session resume helper
  agent-runner.ts           — HTTP server on :3100, SDK query loop, request_input MCP tool
config/
  paradise.office.json      — Paradise roster + room geometry (source of truth for desks)
  dontcall.office.json      — Don't Call roster + room geometry
agent-workspaces/<office>/<agent>/
  CLAUDE.md                 — agent persona (read at session start)
  MEMORY.md                 — optional, written on break-time, read on resume
public/sprites/
  characters/               — LimeZu premade character sheets (premade_01..)
  interiors/                — LimeZu interior tilesheets + premade_rooms/
docs/BUILDING.md            — this file
AGENTS.md                   — pointer: "This is NOT the Next.js you know" (Next 16 rules)
CLAUDE.md                   — @AGENTS.md (what every Claude Code session reads first)
data/robots.db              — SQLite (gitignored)
```

---

## OfficeConfig schema (`lib/office-types.ts`)

```ts
OfficeConfig = {
  slug: string;
  name: string;
  theme: ThemeConfig;      // colors + optional paletteFilter (ColorMatrix) + premadeRoom
  tile: { w, h };          // world px per grid cell (Paradise: 48, Don't Call: 32)
  grid: { cols, rows };    // world size in grid cells
  rooms: RoomConfig[];     // { id, name, gridX, gridY, w, h } rectangles
  desks: DeskConfig[];     // { id, roomId, gridX, gridY, facing: "N"|"E"|"S"|"W" }
  agents: AgentConfig[];   // { id, deskId, name, role, visual.premade, isReal, cwd?, allowedTools?, model? }
}
```

Grid coords are cell-indexed from `(0,0)` top-left. `gridX * tile.w` → world px. A desk must sit inside a room rectangle (not enforced in code but expected).

**Adding a new desk:** add a `desks[]` entry with a `roomId` that exists, then an `agents[]` entry referencing the new `deskId`. No migrations needed — configs are read at request time.

---

## Sprite system

`lib/sprite-loader.ts` slices LimeZu Modern Interiors character sheets on demand. Each character sheet is a 24-col × N-row grid of 16x16 frames.

**⚠️ Gotcha (fixed but easy to reintroduce):** the LimeZu sheet has **S (south/front) at column offset 18 and E (east) at offset 0** — opposite of what the layout docstring in the pack implies. `DIR_COL_OFFSETS` in `sprite-loader.ts:86` holds the corrected mapping. If characters suddenly face the wrong way after touching the loader, check this first.

**Premade rooms:** Paradise uses a Japanese lounge, Don't Call uses a museum room. Both are composed PNG layers (floor + furniture). `theme.premadeRoom.characterDepthIndex` decides which layers render above the character container (for hanging lights, front railings, etc.).

**Scaling:** tiles are rendered at 16px source, upscaled to `tile.w` / `tile.h` via Pixi `scale`. Both offices use `roundPixels: true` for crisp pixel art.

---

## Database (SQLite, `data/robots.db`)

| Table | Purpose |
|-------|---------|
| `tasks` | Task tray items + bodies for all prompts (including chat follow-ups via quick-run) |
| `assignments` | A task dropped on a desk — `agent_id`, `desk_id`, `office_slug`, `assigned_at`, nullable `completed_at` |
| `agent_runs` | One row per SDK query; stores `session_id`, status, token counts, `acknowledged_at` |
| `run_events` | Append-only stream per run: `assistant`, `tool_use`, `input_request`, `input_reply`, `status` |
| `session_resets` | Break-time markers. Runs "since last reset" for an agent = the current session |

**Status values for `agent_runs.status`:** `starting`, `running`, `awaiting_input`, `done`, `error`.

**Migrations:** `migrate()` in `server/db.ts` is idempotent — `CREATE TABLE IF NOT EXISTS` + a PRAGMA-guarded column-add loop. Never drop or rename columns; add only.

**Session continuity helper:**

```ts
getResumeSessionId(officeSlug, agentId): string | null
```

Returns the latest `session_id` on an `agent_runs` row where `started_at > last reset_at` for that agent. The runner passes this to SDK `query({ options: { resume } })` on every real run, so the agent continues from prior context until break time.

---

## How a message flows end-to-end

1. Connor types in the inspector chat footer (or @-mentions in the prompt bar, or drags a task onto a desk).
2. Frontend POSTs `/api/quick-run` (or `/api/assignments` + `/api/runs` for the drag path).
3. `tasks` row + `assignments` row created in one transaction.
4. If `isReal`, route POSTs to runner `:3100/runs` with `{assignmentId, agentId, officeSlug, prompt}`.
5. Runner creates `agent_runs` row (`status='starting'`), inserts `status` event, returns `runId` to caller.
6. Runner `runAgent()` fire-and-forget:
   - Looks up agent from config; resolves `cwd` (absolute, `mkdir -p`).
   - Calls `getResumeSessionId` → prior `session_id` or null.
   - Builds a per-run MCP server exposing one blocking tool: `request_input({ question })`.
   - Opens SDK `query({ prompt, options: { cwd, allowedTools, settingSources: ["project"], mcpServers, model?, resume? } })`.
7. Runner iterates the SDK async generator:
   - `assistant` → insert `assistant` / `tool_use` events, add token deltas.
   - `result` → final token totals, `status='done'`, `ended_at`.
   - Caught errors → `status='error'`.
8. Inspector SSE `/api/runs/:id/stream` tails `run_events` → chat view renders live text.
9. Roster polls every 5s (`app/page.tsx`) → indicators (`!` / `✓`) derive from `{runStatus, acknowledged_at}`.
10. Opening the inspector auto-POSTs `/api/runs/:id/ack` for `done` runs → indicator clears.

### The `request_input` blocking tool

Lives in `server/agent-runner.ts:63` (`makeInputServer`). When the agent calls `request_input`:

1. Insert `input_request` event with the question.
2. Flip `agent_runs.status` to `awaiting_input`.
3. Return a `Promise` that parks in the `waiters: Map<runId, resolve>` registry.
4. Front-end shows the `!` indicator + yellow question card + reply input.
5. `POST /api/runs/:id/reply` with `{reply}` → pulls from `waiters`, resolves the promise.
6. Tool returns reply string to the SDK; status flips back to `running`; run continues.

Single-process runner, so in-memory waiters are fine. Runs that die mid-wait get an empty string in the `finally` block of `runAgent` to unblock the tool promise.

### Break-time flow (`/api/break`)

1. Looks up current `resume` session_id.
2. Creates a `break time` task + assignment, posts to runner with an explicit wrap-up prompt (see `BREAK_PROMPT`).
3. Agent reads/writes `./MEMORY.md` in its `cwd` and sends a one-line confirmation.
4. **After** starting the wrap-up run, inserts a `session_resets` row. The wrap-up run's `started_at` is `<=` reset_at, so future runs won't resume into it — they'll start fresh and the agent re-reads `MEMORY.md` at session start.

---

## Changelog system (`data/changelog.jsonl`)

Every agent has a `robots-changelog` MCP server with two tools:

- **`log_change`** — append a structured entry after making any environment change
- **`query_changelog`** — read/filter past entries (by agent, office, category, date)

The ledger is append-only JSONL at `data/changelog.jsonl`. Each line:
```jsonl
{"ts":"2026-04-15T19:30:00Z","agent":"buzzer","office":"dontcall","category":"config","summary":"Created agent Buzzer in Ops room","reasoning":"Needed dedicated incoming-SMS handler","files":["config/dontcall.office.json"]}
```

Categories: `config` (office JSON), `code` (project files), `architecture` (roles/tools/structure), `workspace` (agent's own CLAUDE.md/MEMORY.md).

Agents are instructed to call `log_change` after meaningful changes and `query_changelog` before complex work. The server is wired in `makeChangelogServer()` in `server/agent-runner.ts` and auto-attached to every agent (not just heads).

---

## Adding a new real agent (end-to-end)

1. **Pick a room with space.** Rooms are defined in `config/<office>.office.json`; desks must fit inside.
2. **Add a desk:**
   ```json
   { "id": "desk-new", "roomId": "existing-room", "gridX": 5, "gridY": 7, "facing": "S" }
   ```
3. **Add the agent:**
   ```json
   {
     "id": "newagent",
     "deskId": "desk-new",
     "name": "NewAgent",
     "role": "Short role",
     "spritePack": "limezu/office/0N",
     "visual": { "premade": "premade_12.png" },
     "isReal": true,
     "cwd": "agent-workspaces/<office>/newagent",
     "allowedTools": ["Read", "Write", "Edit", "Grep", "Glob", "Bash"]
   }
   ```
   Add `"model": "claude-opus-4-6"` only for directors; line agents use SDK default (Sonnet).
4. **Write the persona:** `agent-workspaces/<office>/newagent/CLAUDE.md`. Use existing line-agent files as templates. Required sections: role, memory, how you work, `request_input` guidance, never rules.
5. **That's it.** The workspace dir auto-creates on first run (runner does `mkdirSync(cwd, { recursive: true })`). Next roster poll picks up the new agent; reload the page to see the sprite.

---

## Adding a feature — the pattern

Three places to touch for most features:

1. **DB / API** — add a route under `app/api/.../route.ts`. Follow existing shape: `NextResponse.json`, validate inputs, return 4xx on missing fields. Read/write SQLite via `db()` from `@/server/db`.
2. **Frontend state** — for per-agent or office-wide state, extend `app/page.tsx` (roster state is already lifted there). For local UI, use a leaf component.
3. **Pixi** — only if drawing on canvas. See `components/pixi/Office.tsx`. The indicator system (busy pip + `!` + `✓`) is the template — sprite bundle holds the Graphics, ticker bobs them, ref-based click handler avoids re-binding.

**Runner-side features** (new tools, new agent behaviors) go in `server/agent-runner.ts`. Restart the runner when changing this file (tsx-watch handles it).

---

## Conventions & gotchas

- **Next.js 16 + Turbopack + React 19.2.** Don't assume older patterns. `AGENTS.md` explicitly says "This is NOT the Next.js you know." Consult `node_modules/next/dist/docs/` when unsure.
- **Types live in `lib/office-types.ts`.** Keep `OfficeConfig` stable — both office JSONs must match it.
- **PixiJS v8.** `eventMode: "static"` for clickable, `cursor: "pointer"` for hover, `roundPixels: true` globally for crisp art.
- **Ref-pattern for Pixi event handlers** so React re-renders don't re-bind every tick. See `onSelectRef` / `onAgentClickRef` / `onIndicatorClickRef` in `Office.tsx`.
- **Ticker signature comparison** — the indicator tick only writes visibility when the status-sig or busy-sig changed, to avoid per-frame Graphics churn. See `computeStatusSig` in `Office.tsx`.
- **Polling > websockets** for simple state. Roster = 5s poll. SSE is *only* for per-run live streams.
- **DB migrations are additive.** `migrate()` loops and `ALTER TABLE ADD COLUMN` only if missing.
- **SDK resume** silently no-ops if the session_id no longer exists. Break-time takes advantage of this — the reset row's timestamp cuts off the prior session_id lookup.
- **LimeZu direction swap** — `DIR_COL_OFFSETS` in `sprite-loader.ts` has S=18, E=0. If this flips, everyone faces the wall.
- **Top-down, not isometric.** Earlier builds were iso; LimeZu is top-down so the whole pack is used natively. Don't re-introduce iso math.

---

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| ⌘K / Ctrl-K | Command palette (switch office, focus agent) |
| G | Toggle grid overlay (shows tile coords for desk placement) |
| Esc | Dismiss sprite bubble |

Suppressed when typing in `input` / `textarea` (`app/page.tsx` key handler does the check).

---

## Verification workflow (Claude Preview MCP)

When working on UI, confirm visually:

1. `preview_start name:"next-dev"` (or reuse existing serverId from `preview_list`).
2. `preview_snapshot` for a11y tree (best for verifying text/element presence).
3. `preview_screenshot` for layout.
4. `preview_click selector:"..."` or `preview_eval expression:"..."` for interaction.
5. `preview_console_logs level:"error"` to catch runtime errors.

Never rely on screenshots for colors / font sizes — use `preview_inspect` for precise style props.

---

## What's NOT built (known gaps)

- **Walk animations between desks.** `walkN/E/S/W` frames are loaded but unused.
- **Real desk sprites.** Desks are invisible hit-zones over painted room art. Agents float if moved to cells without underlying furniture.
- **Assignment closing.** `assignments.completed_at` is never set on done runs. History still works (orders by `assigned_at`), but "completed" state is implicit.
- **Model-split usage tracker.** Usage is a single rolling total across all real agents.
- **Director liveness pings.** No "is she alive?" signal aside from the run status.
- **Multi-agent broadcast.** Chat/bubble is single-agent only.
- **Deployment.** App is local-only. No Vercel config for the dual-process shape; runner would need its own deployment target or become a Next route.

---

## When Connor asks you to build something

1. Restate the ask in one sentence. Flag tradeoffs.
2. Sketch the smallest change (which files? which route? DB change needed?).
3. Get agreement, then build.
4. Verify visually in preview.
5. On break time, capture what you learned in `MEMORY.md`.

Don't refactor beyond the ask. Don't add features Connor didn't request.
