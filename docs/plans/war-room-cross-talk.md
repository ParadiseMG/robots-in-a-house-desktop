# War Room: cross-talk (round 2)

## Context

The War Room shipped, but each attendee runs in isolation — Foreman never sees what Watcher said. That breaks the spirit of a meeting; it's just N parallel 1:1s. Devy's clips show the head pulling out one thread after the others have weighed in. This adds a second round: after round 1 finishes, the head clicks "Cross-talk →" and every agent gets re-prompted with peers' round-1 replies, asked to react.

User picked: **inter-agent visibility (option #1)** for smallest-scope-biggest-payoff.

## Approach

**Manual trigger, uncapped rounds.** No auto-loop. After all round-N runs hit `done`/`error`, a "Cross-talk →" button is enabled in the modal header. Click → POST `/api/war-room/[id]/round`. Server reads each attendee's *latest* assistant event (whichever round they're on), builds a peer-transcript block, fans out one new run per attendee using the same `assignment_id` (so the existing `meeting_attendees` mapping still works) and `resume: <latest_session_id>` (so the agent keeps its own prior context — only the peer messages need to land in the new prompt). Head can click as many times as they want; each click adds another round.

No DB schema change. "Rounds" are derived from the count of `agent_runs` rows per assignment, ordered by `started_at`.

## Files

| File | Change |
|---|---|
| `app/api/war-room/[id]/route.ts` | Return `attendees[].runs: [{round, runId, status, tailSnippet}]` instead of single latest. Compute `roundsCompleted` (max round where every attendee is `done`/`error`) and `currentRound` (max round number across all attendees). |
| `app/api/war-room/[id]/round/route.ts` **(new)** | POST: validate latest round is settled (every attendee `done`/`error`), build peer-transcript prompt per attendee, fan out new runs to runner with `resume: <latest_session_id>` from each attendee's most recent run. Returns `{ round: <new_round_number>, runs: [...] }`. |
| `components/war-room/MeetingModal.tsx` | Render rounds as stacked sections per attendee column (Round 1 / Round 2 / Round N reply). Show "Cross-talk →" button in header when `currentRound === roundsCompleted` (i.e., the latest round is settled). Disabled while any attendee is `running`/`starting`. Stays clickable indefinitely. |

No changes to: runner (`server/agent-runner.ts`), DB schema (`server/db.ts`), war-room run route.

## Cross-talk prompt template

```
The team just shared their latest takes. Here's what your peers said:

### {peerName} ({peerRole})
{peerReplyText}

### {peerName2} ({peerRole2})
{peerReplyText2}

…

React: where do you agree, where do you push back, what's still unclear? Keep it tight — one paragraph max.
```

Built server-side in the new round endpoint. Peer list excludes self. Reply text pulled from last `run_events` row of `kind='assistant'` for each peer's *latest* run (same query the GET endpoint already runs at `app/api/war-room/[id]/route.ts:46-52`). Same wording on every round — round 3 sees round-2 replies, round 4 sees round-3, etc.

## What's reused

- Runner's existing `resume` param (already wired at `server/agent-runner.ts:222`) — keeps each agent's own round-1 context without re-stuffing it.
- `meeting_attendees` mapping unchanged; each new round just inserts another `agent_runs` row for the same assignment_id.
- The polling loop in `MeetingModal.tsx:101-125` — same shape, just renders more data.
- Tail-snippet truncation logic in `app/api/war-room/[id]/route.ts:54-58`.

## Out of scope (deferred to future slices)

- **Mid-run agent-to-agent messaging** — agents still can't *talk to each other while running*. Future slice would add a `message_peer(agentId, text)` MCP tool, a per-agent inbound message queue, and an interrupt/poll mechanism in the agent's loop. Substantial scope; bundling here would muddy the verification story.
- **Past meetings view** — that's the next slice (#3 from our short-list).
- **Auto-triggering rounds** — keep manual control. Head decides when the conversation is done.
- **Per-peer reply visibility controls** — every attendee sees every peer. Future could add "private side-conversations" but not this slice.

## Verification

1. Convene war room in Don't Call with 3 agents (Foreman + Dial + Buzzer), prompt: "What's blocking us this week?"
2. Wait for all three to hit `done` in round 1 (~30s).
3. Header should show **"Cross-talk →"** button in brand-accent color. Status flips to "round 1 done".
4. Click button → button greys out, columns get a "Round 2" sub-section under the round-1 reply with status pills `running`.
5. Within ~30s each agent's Round 2 cell shows a reaction that references at least one peer by name (e.g., Buzzer says "to Dial's point about callback latency…").
6. Button re-enables. Click again → Round 3 section appears, agents react to round-2 replies. Confirms uncapped rounds work.
7. `sqlite3 .data/state.db "SELECT assignment_id, COUNT(*) FROM agent_runs GROUP BY assignment_id ORDER BY assignment_id"` — each war-room assignment has 3 rows after step 6.
8. Try POST `/api/war-room/<id>/round` while a round still has a `running` agent → 409 with clear error.
9. Open the inspector for one of the agents — full transcript shows all rounds as sequential sessions (since `resume` was used).

## Failure modes

- Runner crashed mid-round-1 → some assignments have `running` status forever; the round endpoint will refuse with 409. Existing problem, not introduced here.
- Peer reply text empty (agent ran but produced no text blocks) → include a placeholder "(no reply)" so the prompt template stays valid.
- `session_id` missing on round 1's `agent_runs` row (rare; runner sets it from SDK) → fall back to a fresh session and stuff the agent's own round-1 reply into the prompt under "### your last reply".
