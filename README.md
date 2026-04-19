# robots-in-a-house

Top-down pixel-art office where you work alongside AI agents. Each agent is a real Claude session with its own desk, role, memory, and tools. Opus agents plan and delegate. Sonnet agents build.

## Quick start

```bash
git clone https://github.com/ParadiseMG/robots-in-a-house.git
cd robots-in-a-house
npm install
npm run dev
```

Open `localhost:3000`. The app ships with an **Example Office** (Director + Builder) so you can start immediately.

## Auth setup

Agents need Claude API access to run. Two options:

**Option A — Claude Max (recommended)**
```bash
claude setup-token
```
This stores OAuth credentials in your keychain. The runner picks them up automatically.

**Option B — API key**
```bash
cp .env.example .env.local
```
Set `ANTHROPIC_API_KEY=sk-ant-...` in `.env.local`.

## What's running

`npm run dev` starts two processes:

| Process | Port | What it does |
|---------|------|-------------|
| Next.js | 3000 | UI, API routes, setup wizard |
| Agent Runner | 3100 | Executes Claude sessions via the Agent SDK |

The SQLite database auto-creates in `data/` on first boot.

## Creating your own workspace

Three ways:

1. **Setup wizard** — visit `localhost:3000/setup` (auto-redirects on fresh installs)
2. **Workspace builder** — click the robot icon in the top-right toolbar for advanced config
3. **In-app** — click any agent's `+` button to create agents on the fly

The setup wizard lets you name your workspace, pick a room, choose a team template, and customize agents. Everything is saved to `config/<slug>.office.json`.

## How agents work

- **Opus agents** (Directors/Heads) plan, research, and delegate via `delegate_task`
- **Sonnet agents** (Builders) take specific tasks and ship code
- Click any agent to chat. They have full tool access: Read, Write, Edit, Grep, Glob, Bash, WebSearch, WebFetch
- Agents persist memory across sessions via `MEMORY.md` in their workspace

## Memory system

Every agent has a workspace at `agent-workspaces/<office>/<agent>/` containing:

- `CLAUDE.md` — identity, role, rules (loaded automatically by the SDK)
- `MEMORY.md` — persistent memory across sessions

The runner automatically injects `MEMORY.md` into every fresh run. Agents are responsible for updating it when a session ends. New agents created through the UI get both files from a template.

## Project structure

```
config/              Office configs (*.office.json)
agent-workspaces/    Per-agent workspaces (CLAUDE.md, MEMORY.md)
app/                 Next.js pages and API routes
components/          React components (dock, canvas, errors, etc.)
server/              Agent runner, database, error reporting
lib/                 Shared types, config loader, agent builder
public/sprites/      LimeZu pixel art assets
data/                SQLite database (gitignored, auto-created)
```

## Key files for contributors

- `docs/BUILDING.md` — full architecture, DB schema, message flow, conventions
- `AGENTS.md` — model routing rules and memory contract (inherited by all agents)
- `server/agent-runner.ts` — the runner that executes all agent sessions
- `lib/agent-builder.ts` — creates new agents with workspace + templates
- `lib/config-loader.ts` — discovers office configs dynamically from disk

## Credits

Character and interior sprites by LimeZu — https://limezu.itch.io/moderninteriors
