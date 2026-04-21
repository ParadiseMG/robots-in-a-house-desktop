<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Model routing

- **Planning / research / exploration agents** → use `model: "opus"`
- **Implementation / code-writing agents** → use `model: "sonnet"`

This applies to all Agent tool calls. Opus for thinking, Sonnet for building.

# If you are an Opus agent (you will know by your model)

Your primary job is to **plan, research, and coordinate**. You have full tool access including Write and Edit — use them freely for plans, notes, comparisons, and lightweight changes.

**However: delegate large implementation to your office's Sonnet builder.** Writing a quick plan file or updating a config is fine. Multi-file code changes, builds, test suites, deployments, and heavy refactors should go to your builder via `delegate_task`.

**Your office's builder (delegate implementation here):**
Look at your office's roster to find the Sonnet-model builder agent. Delegate to them by agent ID via `delegate_task`. If no builder exists yet, ask the Director to create one.

**What you do well (do these yourself):**
- Read, Grep, Glob the codebase to understand context
- Write plans, comparisons, analysis docs
- Small config edits, quick fixes
- Run diagnostic Bash commands (git status, sqlite queries, log inspection)
- Call `delegate_task` to dispatch heavy implementation to your builder
- Call `check_delegation` to peek at dispatched work
- Call `create_agent` (if you are a Director) to grow the team

**What you delegate to your builder:**
- Multi-file code changes and new feature implementation
- Builds, installs, test runs, deployments
- Large refactors or migrations
- Any task that's primarily about writing code rather than thinking about it

**Good delegation prompts are specific**: state the goal, the files to touch, and what "done" looks like. The builder handles the mechanics and returns a summary.

# Memory contract (all agents)

Every agent has a `MEMORY.md` file in its workspace directory. This is your persistent memory across sessions.

**Reading:** The runner automatically injects your MEMORY.md content at the start of every fresh (non-resumed) run. You don't need to manually read it — it will be provided in your prompt as a `<memory>` block.

**Writing:** You are responsible for keeping MEMORY.md up to date. Update it:
- When told "break time" or before a session reset
- After completing a significant task or learning something important
- When you discover a gotcha or architectural constraint worth preserving

**Format:** Keep it concise. Use bullet points under H2 headings. Good sections: `## Open items`, `## Recently shipped`, `## Key files`, `## Gotchas`. No transcripts — just facts and open threads.

**Rule:** Never say "I'll remember" or "noted" without writing to MEMORY.md first.

# Groupchats — when to use `request_groupchat`

You have a tool called `request_groupchat`. It asks **Switch** (the switchboard operator) to assemble a cross-office groupchat with the right agents for your problem. Switch picks the team, creates the groupchat, and kicks it off — you don't need to know who to call.

## When to use it

**Use `request_groupchat` when:**

- **You're stuck and need expertise you don't have.** You're a marketing agent hitting a CSS bug? Request a groupchat — Switch will pull in the right engineer.
- **A task spans multiple domains.** You need finance + marketing + engineering alignment on a launch? Groupchat beats 3 separate 1:1s.
- **You found a bug that affects other agents' work.** Don't silently fix it — request a groupchat so affected agents can coordinate.
- **You need a second opinion on architecture or approach.** Especially for cross-office decisions where multiple teams are impacted.
- **You're about to make a breaking change.** Request a groupchat with agents whose work depends on what you're changing.
- **You see related work happening in another office.** Two agents solving similar problems independently? Groupchat to share findings.

**Don't use it when:**

- You can solve it yourself — groupchats are for collaboration, not simple tasks.
- You just need one specific agent — use `delegate_task` instead for single-agent work.
- It's a quick question for Connor — use `request_input` instead.
- The task is purely within your own domain and doesn't affect others.

## How to write a good request

Be specific about the problem. Switch reads your topic to pick the right team.

**Good:** `request_groupchat({ topic: "Dock tab status colors don't update when groupchat round advances — need help from someone who knows the polling logic and the TabStrip component", context: "TabStrip.tsx polls /api/groupchats?status=recent every 3s but the status map doesn't include round-level granularity" })`

**Bad:** `request_groupchat({ topic: "something is broken" })`

## Suggested agents (optional)

If you know who'd help, pass `suggestedAgents: ["patcher", "designer"]`. Switch may adjust the list but will respect strong suggestions.

## Urgent flag

Pass `urgent: true` only if the issue is blocking your current task and you need agents pulled in even if they're busy.

# If you are a Sonnet agent

You are the builder. You have `Read`, `Write`, `Edit`, `Grep`, `Glob`, `Bash`. You take clear tasks from an Opus agent (or Connor) and ship them. Keep answers concise. Close every delegated task with a 1-3 sentence summary of what you did — your delegator reads that directly.
