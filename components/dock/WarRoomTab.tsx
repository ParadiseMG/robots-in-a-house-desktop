"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useDockTabs } from "@/hooks/useDockTabs";
import type { OfficeConfig } from "@/lib/office-types";

type AttendeeRun = {
  round: number;
  runId: string;
  status: string;
  tailSnippet: string | null;
};

type Attendee = {
  agentId: string;
  assignmentId: string;
  runId: string | null;
  runStatus: string;
  tailSnippet: string | null;
  runs: AttendeeRun[];
};

type Synthesis = {
  runId: string;
  status: string;
  text: string | null;
};

type MeetingState = {
  meetingId: string;
  convenedAt: number;
  attendees: Attendee[];
  status: "running" | "done";
  roundsCompleted: number;
  currentRound: number;
  targetRounds: number;
  synthesis: Synthesis | null;
};

type RosterEntry = {
  agent: { id: string; deskId: string };
  current: { runStatus: string | null; acknowledgedAt: number | null } | null;
};

type Props = {
  tabId: string;
  officeSlug: string;
  office: OfficeConfig;
  roster: RosterEntry[] | null;
};

const POLL_MS = 1500;

function statusColor(runStatus: string, accentColor: string): string {
  if (runStatus === "done") return accentColor;
  if (runStatus === "error") return "#f87171";
  if (runStatus === "awaiting_input") return "#fde047";
  if (runStatus === "running") return "#7dd3fc";
  return "#a1a1aa";
}

export default function WarRoomTab({ tabId, officeSlug, office, roster }: Props) {
  const { dispatch } = useDockTabs();
  const head = useMemo(() => office.agents.find((a) => a.isHead) ?? null, [office]);
  const realAgents = useMemo(() => office.agents.filter((a) => a.isReal), [office]);

  const [picked, setPicked] = useState<Set<string>>(() => {
    const s = new Set<string>();
    if (head) s.add(head.id);
    return s;
  });
  const [prompt, setPrompt] = useState("");
  const [targetRounds, setTargetRounds] = useState(2);
  const [submitting, setSubmitting] = useState(false);
  const [crossTalking, setCrossTalking] = useState(false);
  const [synthesizing, setSynthesizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meeting, setMeeting] = useState<MeetingState | null>(null);

  // Hydrate from persisted meetingId (e.g. clicking an active war room event)
  const { tabs } = useDockTabs();
  const thisTab = tabs.find((t) => t.id === tabId);
  const persistedMeetingId = thisTab?.meetingId ?? null;

  useEffect(() => {
    if (meeting || !persistedMeetingId) return;
    (async () => {
      try {
        const res = await fetch(`/api/war-room/${encodeURIComponent(persistedMeetingId)}`);
        if (!res.ok) return;
        const j = (await res.json()) as MeetingState;
        setMeeting(j);
      } catch {
        // ignore — will show the picker instead
      }
    })();
  }, [persistedMeetingId, meeting]);

  const togglePick = (agentId: string) => {
    if (head && agentId === head.id) return;
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  const convene = async () => {
    if (!prompt.trim() || picked.size === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/war-room/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          officeSlug,
          agentIds: Array.from(picked),
          prompt: prompt.trim(),
          convenedBy: head?.id,
          targetRounds,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `convene failed (${res.status})`);
      }
      const j = (await res.json()) as {
        meetingId: string;
        convenedAt: number;
        attendees: Array<{ agentId: string; assignmentId: string; runId: string | null }>;
      };
      const newMeeting: MeetingState = {
        meetingId: j.meetingId,
        convenedAt: j.convenedAt,
        attendees: j.attendees.map((a) => ({
          agentId: a.agentId,
          assignmentId: a.assignmentId,
          runId: a.runId,
          runStatus: "queued",
          tailSnippet: null,
          runs: [],
        })),
        status: "running",
        roundsCompleted: 0,
        currentRound: 1,
        targetRounds,
        synthesis: null,
      };
      setMeeting(newMeeting);
      dispatch({ type: "SET_MEETING_ID", id: tabId, meetingId: j.meetingId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const [roundMessage, setRoundMessage] = useState("");

  const crossTalk = async (message?: string) => {
    if (!meeting) return;
    setCrossTalking(true);
    setError(null);
    try {
      const body: Record<string, string> = {};
      const msg = message?.trim() || roundMessage.trim();
      if (msg) body.message = msg;
      const res = await fetch(`/api/war-room/${encodeURIComponent(meeting.meetingId)}/round`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `cross-talk failed (${res.status})`);
      }
      // Immediately kick a poll so the UI reflects the new running round
      const pollRes = await fetch(`/api/war-room/${encodeURIComponent(meeting.meetingId)}`);
      if (pollRes.ok) {
        const j = (await pollRes.json()) as MeetingState;
        setMeeting((prev) => (prev ? { ...prev, ...j } : prev));
      }
      setRoundMessage("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCrossTalking(false);
    }
  };

  // Poll meeting status
  useEffect(() => {
    if (!meeting) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/war-room/${encodeURIComponent(meeting.meetingId)}`);
        if (!res.ok) return;
        const j = (await res.json()) as MeetingState;
        if (cancelled) return;
        setMeeting((prev) => (prev ? { ...prev, ...j } : prev));
      } catch {
        // ignore
      }
    };
    void tick();
    const id = setInterval(() => {
      // Stop polling only when: all runs settled, all target rounds reached,
      // and synthesis either not needed (single round) or itself settled.
      const roundsDone = meeting.roundsCompleted >= meeting.targetRounds;
      const synthDone =
        meeting.targetRounds <= 1 ||
        meeting.synthesis?.status === "done" ||
        meeting.synthesis?.status === "error";
      if (meeting.status === "done" && roundsDone && synthDone) return;
      void tick();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [meeting?.meetingId, meeting?.status, meeting?.synthesis?.status, meeting?.roundsCompleted, meeting?.targetRounds]);

  // Auto-advance rounds until targetRounds reached, then trigger synthesis
  const autoAdvanceLockRef = useRef<string>("");
  const synthesisLockRef = useRef<string>("");
  useEffect(() => {
    if (!meeting) return;
    if (crossTalking || synthesizing) return;
    if (meeting.synthesis) return; // already synthesized

    const settled =
      meeting.currentRound > 0 &&
      meeting.roundsCompleted === meeting.currentRound;
    if (!settled) return;

    if (meeting.roundsCompleted < meeting.targetRounds) {
      const key = `${meeting.meetingId}:advance:${meeting.roundsCompleted}`;
      if (autoAdvanceLockRef.current === key) return;
      autoAdvanceLockRef.current = key;
      void (async () => {
        setCrossTalking(true);
        setError(null);
        try {
          const res = await fetch(`/api/war-room/${encodeURIComponent(meeting.meetingId)}/round`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
          if (!res.ok) {
            const j = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(j.error ?? `auto-advance failed (${res.status})`);
          }
          const pollRes = await fetch(`/api/war-room/${encodeURIComponent(meeting.meetingId)}`);
          if (pollRes.ok) {
            const j = (await pollRes.json()) as MeetingState;
            setMeeting((prev) => (prev ? { ...prev, ...j } : prev));
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setCrossTalking(false);
        }
      })();
    } else if (meeting.targetRounds > 1) {
      const key = `${meeting.meetingId}:synth`;
      if (synthesisLockRef.current === key) return;
      synthesisLockRef.current = key;
      void (async () => {
        setSynthesizing(true);
        setError(null);
        try {
          const res = await fetch(`/api/war-room/${encodeURIComponent(meeting.meetingId)}/synthesize`, {
            method: "POST",
          });
          if (!res.ok) {
            const j = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(j.error ?? `synthesis failed (${res.status})`);
          }
          const pollRes = await fetch(`/api/war-room/${encodeURIComponent(meeting.meetingId)}`);
          if (pollRes.ok) {
            const j = (await pollRes.json()) as MeetingState;
            setMeeting((prev) => (prev ? { ...prev, ...j } : prev));
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setSynthesizing(false);
        }
      })();
    }
  }, [
    meeting?.meetingId,
    meeting?.roundsCompleted,
    meeting?.currentRound,
    meeting?.targetRounds,
    meeting?.synthesis?.runId,
    crossTalking,
    synthesizing,
  ]);

  const agentNameById = useMemo(() => {
    const m = new Map<string, { name: string; role: string; deskId: string }>();
    for (const a of office.agents) m.set(a.id, { name: a.name, role: a.role, deskId: a.deskId });
    return m;
  }, [office]);

  const accentColor = office.theme.accent;

  if (!meeting) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {/* Attendee picker */}
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-white/40">
            attendees
          </div>
          <div className="flex flex-wrap gap-1.5">
            {realAgents.map((a) => {
              const isHead = head?.id === a.id;
              const on = picked.has(a.id);
              const rosterEntry = roster?.find((r) => r.agent.id === a.id);
              const busy = rosterEntry?.current?.runStatus === "running";
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => togglePick(a.id)}
                  disabled={isHead}
                  className={`rounded-sm border px-2 py-1 text-[11px] transition ${
                    on
                      ? "border-current text-zinc-100"
                      : "border-white/15 text-zinc-500 hover:text-zinc-300"
                  } ${isHead ? "cursor-default" : ""}`}
                  style={on ? { borderColor: accentColor, color: accentColor } : undefined}
                  title={isHead ? "head — always present" : a.role}
                >
                  {a.name}
                  {isHead && <span className="ml-1 opacity-60">(head)</span>}
                  {busy && !isHead && <span className="ml-1 opacity-60">·busy</span>}
                </button>
              );
            })}
          </div>
        </div>

        {/* Prompt */}
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-white/40">
            prompt
          </div>
          <textarea
            className="h-24 w-full resize-none border border-white/10 bg-black/60 p-2 font-mono text-xs text-zinc-100 outline-none focus:border-white/30"
            placeholder="What's blocking us this week?"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            autoFocus
          />
        </div>

        {/* Auto rounds */}
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-white/40">
            auto rounds
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {[1, 2, 3, 4].map((n) => {
              const on = targetRounds === n;
              return (
                <button
                  key={n}
                  type="button"
                  onClick={() => setTargetRounds(n)}
                  className={`rounded-sm border px-2 py-1 font-mono text-[11px] transition ${
                    on
                      ? "text-zinc-100"
                      : "border-white/15 text-zinc-500 hover:text-zinc-300"
                  }`}
                  style={on ? { borderColor: accentColor, color: accentColor } : undefined}
                >
                  {n === 1 ? "1 round" : `${n} rounds`}
                </button>
              );
            })}
            <span className="ml-1 font-mono text-[10px] text-white/30">
              {targetRounds === 1
                ? "manual · you drive each round"
                : `runs ${targetRounds} rounds then synthesizes`}
            </span>
          </div>
        </div>

        {error && <div className="text-xs text-red-400">{error}</div>}

        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] text-white/40">
            {picked.size} agent{picked.size === 1 ? "" : "s"} · runs in parallel
          </span>
          <button
            type="button"
            onClick={convene}
            disabled={submitting || !prompt.trim() || picked.size === 0}
            className="border px-3 py-1.5 font-mono text-xs uppercase tracking-wider transition disabled:cursor-not-allowed disabled:opacity-40"
            style={{ borderColor: accentColor, color: accentColor }}
          >
            {submitting ? "convening…" : "convene"}
          </button>
        </div>
      </div>
    );
  }

  const autoRunning =
    meeting.targetRounds > 1 &&
    (meeting.roundsCompleted < meeting.targetRounds || !meeting.synthesis);
  const canCrossTalk =
    !autoRunning &&
    meeting.currentRound > 0 &&
    meeting.currentRound === meeting.roundsCompleted &&
    !crossTalking &&
    !synthesizing;

  const progressLabel = (() => {
    if (meeting.synthesis?.status === "done") return "synthesis ready";
    if (synthesizing || meeting.synthesis?.status === "running" || meeting.synthesis?.status === "starting") {
      return "synthesizing…";
    }
    if (meeting.targetRounds > 1) {
      return `round ${meeting.roundsCompleted}/${meeting.targetRounds}${
        crossTalking ? " · advancing…" : meeting.status === "done" ? " · settled" : " · running"
      }`;
    }
    return meeting.roundsCompleted > 0
      ? `round ${meeting.roundsCompleted} done`
      : meeting.status === "done"
      ? "all done"
      : "in progress";
  })();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-white/5 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-white/40">
        <span>
          meeting · {meeting.attendees.length} agents ·{" "}
          {new Date(meeting.convenedAt).toLocaleTimeString()}
        </span>
        <span
          style={{
            color:
              meeting.synthesis?.status === "done"
                ? accentColor
                : meeting.status === "done" && !autoRunning
                ? accentColor
                : "#fde047",
          }}
        >
          {progressLabel}
        </span>
      </div>

      {error && <div className="border-b border-red-900/40 bg-red-950/30 px-3 py-1 text-xs text-red-400">{error}</div>}

      {/* Synthesis banner — shown prominently at top once generated */}
      {meeting.synthesis && (
        <div
          className="border-b px-3 py-2"
          style={{
            borderColor: accentColor + "40",
            background: `linear-gradient(180deg, ${accentColor}15 0%, transparent 100%)`,
          }}
        >
          <div
            className="mb-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-wider"
            style={{ color: accentColor }}
          >
            <span>◆ findings</span>
            <span className="opacity-70">
              {meeting.synthesis.status === "done"
                ? "ready"
                : meeting.synthesis.status === "error"
                ? "error"
                : "synthesizing…"}
            </span>
          </div>
          <div className="whitespace-pre-wrap text-[12px] leading-snug text-zinc-100">
            {meeting.synthesis.text ?? (
              <span className="text-zinc-500">…the head is reading the room</span>
            )}
          </div>
        </div>
      )}

      <div className="grid flex-1 grid-cols-2 gap-px overflow-auto bg-white/5">
        {meeting.attendees.map((att) => {
          const meta = agentNameById.get(att.agentId);
          const rounds = att.runs.length > 0 ? att.runs : [{ round: 1, runId: att.runId ?? "", status: att.runStatus, tailSnippet: att.tailSnippet }];

          return (
            <div key={att.agentId} className="flex flex-col gap-0 bg-zinc-950">
              {/* Agent header */}
              <div className="flex items-baseline justify-between px-2 pt-2 pb-1">
                <div>
                  <div className="text-sm text-zinc-100">{meta?.name ?? att.agentId}</div>
                  <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                    {meta?.role ?? ""}
                  </div>
                </div>
              </div>

              {/* Rounds stacked */}
              <div className="flex flex-col gap-px">
                {rounds.map((run) => {
                  const color = statusColor(run.status, accentColor);
                  return (
                    <div key={run.runId || run.round} className="border-t border-white/5 px-2 py-1.5">
                      <div className="mb-1 flex items-center justify-between">
                        <span className="font-mono text-[9px] uppercase tracking-wider text-zinc-600">
                          round {run.round}
                        </span>
                        <span
                          className="border px-1 py-0.5 font-mono text-[9px] uppercase tracking-wider"
                          style={{ color, borderColor: color + "66" }}
                        >
                          {run.status}
                        </span>
                      </div>
                      <div className="min-h-[48px] whitespace-pre-wrap text-[11px] leading-snug text-zinc-300">
                        {run.tailSnippet ?? <span className="text-zinc-600">…waiting</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Human input bar */}
      <div className="flex items-end gap-2 border-t border-white/10 px-3 py-2">
        <textarea
          rows={1}
          value={roundMessage}
          onChange={(e) => setRoundMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && canCrossTalk) {
              e.preventDefault();
              void crossTalk();
            }
          }}
          disabled={!canCrossTalk}
          placeholder={
            autoRunning
              ? "auto-run in progress…"
              : canCrossTalk
              ? "steer the next round... or leave blank to let them talk"
              : "waiting for round to finish..."
          }
          className="flex-1 resize-none rounded border border-white/10 bg-black/50 px-2 py-1.5 font-mono text-xs text-white placeholder:text-white/25 focus:border-white/25 focus:outline-none disabled:opacity-40"
          style={{ maxHeight: 80 }}
        />
        <button
          type="button"
          onClick={() => void crossTalk()}
          disabled={!canCrossTalk}
          className="shrink-0 rounded border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider transition disabled:cursor-not-allowed disabled:opacity-30"
          style={{ borderColor: accentColor + "99", color: accentColor }}
        >
          {crossTalking ? "…" : roundMessage.trim() ? "send" : "next round"}
        </button>
      </div>
    </div>
  );
}
