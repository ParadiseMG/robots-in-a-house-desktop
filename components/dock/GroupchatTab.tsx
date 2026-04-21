"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useDockTabs } from "@/hooks/useDockTabs";
import type { OfficeConfig } from "@/lib/office-types";

type MemberRun = {
  round: number;
  runId: string;
  status: string;
  tailSnippet: string | null;
};

type Member = {
  agentId: string;
  officeSlug: string;
  assignmentId: string;
  runId: string | null;
  runStatus: string;
  tailSnippet: string | null;
  runs: MemberRun[];
};

type Synthesis = {
  runId: string;
  status: string;
  text: string | null;
};

type GroupchatState = {
  groupchatId: string;
  convenedAt: number;
  persistent: boolean;
  pinnedName: string | null;
  members: Member[];
  status: "running" | "done" | "idle";
  roundsCompleted: number;
  currentRound: number;
  targetRounds: number;
  synthesis: Synthesis | null;
};

type Props = {
  tabId: string;
  /** All loaded offices — needed to pick agents cross-office */
  allOffices: OfficeConfig[];
};

const POLL_MS = 1500;

function statusColor(runStatus: string): string {
  if (runStatus === "done") return "#34d399";
  if (runStatus === "error") return "#f87171";
  if (runStatus === "awaiting_input") return "#fde047";
  if (runStatus === "running") return "#7dd3fc";
  if (runStatus === "idle") return "#71717a";
  return "#a1a1aa";
}

export default function GroupchatTab({ tabId, allOffices }: Props) {
  const { dispatch, tabs } = useDockTabs();
  const thisTab = tabs.find((t) => t.id === tabId);
  const persistedGroupchatId = thisTab?.groupchatId ?? null;

  // All agents from all offices for the picker
  const allAgents = useMemo(() => {
    const agents: Array<{ id: string; name: string; role: string; officeSlug: string; officeName: string; isReal: boolean; deskId: string }> = [];
    for (const office of allOffices) {
      for (const a of office.agents) {
        if (!a.isReal) continue;
        agents.push({
          id: a.id,
          name: a.name,
          role: a.role,
          officeSlug: office.slug,
          officeName: office.name,
          isReal: a.isReal,
          deskId: a.deskId,
        });
      }
    }
    return agents;
  }, [allOffices]);

  // Agent lookup map (by agentId — may collide cross-office but unlikely)
  const agentLookup = useMemo(() => {
    const m = new Map<string, { name: string; role: string; officeSlug: string; officeName: string }>();
    for (const a of allAgents) m.set(a.id, a);
    return m;
  }, [allAgents]);

  // Group agents by office for picker
  const agentsByOffice = useMemo(() => {
    const m = new Map<string, typeof allAgents>();
    for (const a of allAgents) {
      const list = m.get(a.officeSlug) ?? [];
      list.push(a);
      m.set(a.officeSlug, list);
    }
    return m;
  }, [allAgents]);

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState("");
  const [targetRounds, setTargetRounds] = useState(2);
  const [submitting, setSubmitting] = useState(false);
  const [crossTalking, setCrossTalking] = useState(false);
  const [synthesizing, setSynthesizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gc, setGc] = useState<GroupchatState | null>(null);
  const [pinName, setPinName] = useState("");
  const [showPinInput, setShowPinInput] = useState(false);

  // Hydrate from persisted groupchatId
  useEffect(() => {
    if (gc || !persistedGroupchatId) return;
    (async () => {
      try {
        const res = await fetch(`/api/groupchats/${encodeURIComponent(persistedGroupchatId)}`);
        if (!res.ok) return;
        const j = (await res.json()) as GroupchatState;
        setGc(j);
      } catch {}
    })();
  }, [persistedGroupchatId, gc]);

  const togglePick = (agentId: string) => {
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
      const agents = Array.from(picked).map((id) => {
        const a = allAgents.find((a) => a.id === id);
        return { id, officeSlug: a?.officeSlug ?? "" };
      });
      const res = await fetch("/api/groupchats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agents,
          prompt: prompt.trim(),
          convenedBy: "connor",
          targetRounds,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `create failed (${res.status})`);
      }
      const j = (await res.json()) as {
        groupchatId: string;
        convenedAt: number;
        members: Array<{ agentId: string; officeSlug: string; assignmentId: string; runId: string | null }>;
      };
      const newGc: GroupchatState = {
        groupchatId: j.groupchatId,
        convenedAt: j.convenedAt,
        persistent: false,
        pinnedName: null,
        members: j.members.map((m) => ({
          agentId: m.agentId,
          officeSlug: m.officeSlug,
          assignmentId: m.assignmentId,
          runId: m.runId,
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
      setGc(newGc);
      dispatch({ type: "SET_GROUPCHAT_ID", id: tabId, groupchatId: j.groupchatId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const [roundMessage, setRoundMessage] = useState("");

  const crossTalk = async (message?: string) => {
    if (!gc) return;
    setCrossTalking(true);
    setError(null);
    try {
      const body: Record<string, string> = {};
      const msg = message?.trim() || roundMessage.trim();
      if (msg) body.message = msg;
      const res = await fetch(`/api/groupchats/${encodeURIComponent(gc.groupchatId)}/round`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `round failed (${res.status})`);
      }
      const pollRes = await fetch(`/api/groupchats/${encodeURIComponent(gc.groupchatId)}`);
      if (pollRes.ok) {
        const j = (await pollRes.json()) as GroupchatState;
        setGc((prev) => (prev ? { ...prev, ...j } : prev));
      }
      setRoundMessage("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCrossTalking(false);
    }
  };

  const pinGroupchat = async () => {
    if (!gc || !pinName.trim()) return;
    try {
      const res = await fetch(`/api/groupchats/${encodeURIComponent(gc.groupchatId)}/pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: pinName.trim() }),
      });
      if (res.ok) {
        setGc((prev) => prev ? { ...prev, persistent: true, pinnedName: pinName.trim() } : prev);
        setShowPinInput(false);
        setPinName("");
      }
    } catch {}
  };

  const closeGroupchat = async () => {
    if (!gc) return;
    try {
      await fetch(`/api/groupchats/${encodeURIComponent(gc.groupchatId)}/close`, {
        method: "POST",
      });
      setGc((prev) => prev ? { ...prev, status: "idle" } : prev);
    } catch {}
  };

  // Poll
  useEffect(() => {
    if (!gc) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/groupchats/${encodeURIComponent(gc.groupchatId)}`);
        if (!res.ok) return;
        const j = (await res.json()) as GroupchatState;
        if (cancelled) return;
        setGc((prev) => (prev ? { ...prev, ...j } : prev));
      } catch {}
    };
    void tick();
    const id = setInterval(() => {
      const roundsDone = gc.roundsCompleted >= gc.targetRounds;
      const synthDone =
        gc.targetRounds <= 1 ||
        gc.synthesis?.status === "done" ||
        gc.synthesis?.status === "error";
      if (gc.status === "done" && roundsDone && synthDone) return;
      if (gc.status === "idle") return;
      void tick();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [gc?.groupchatId, gc?.status, gc?.synthesis?.status, gc?.roundsCompleted, gc?.targetRounds]);

  // Auto-advance + auto-synthesize
  const autoAdvanceLockRef = useRef<string>("");
  const synthesisLockRef = useRef<string>("");
  useEffect(() => {
    if (!gc) return;
    if (crossTalking || synthesizing) return;
    if (gc.synthesis) return;

    const settled =
      gc.currentRound > 0 &&
      gc.roundsCompleted === gc.currentRound;
    if (!settled) return;

    if (gc.roundsCompleted < gc.targetRounds) {
      const key = `${gc.groupchatId}:advance:${gc.roundsCompleted}`;
      if (autoAdvanceLockRef.current === key) return;
      autoAdvanceLockRef.current = key;
      void (async () => {
        setCrossTalking(true);
        setError(null);
        try {
          const res = await fetch(`/api/groupchats/${encodeURIComponent(gc.groupchatId)}/round`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
          if (!res.ok) {
            const j = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(j.error ?? `auto-advance failed (${res.status})`);
          }
          const pollRes = await fetch(`/api/groupchats/${encodeURIComponent(gc.groupchatId)}`);
          if (pollRes.ok) {
            const j = (await pollRes.json()) as GroupchatState;
            setGc((prev) => (prev ? { ...prev, ...j } : prev));
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setCrossTalking(false);
        }
      })();
    } else if (gc.targetRounds > 1) {
      const key = `${gc.groupchatId}:synth`;
      if (synthesisLockRef.current === key) return;
      synthesisLockRef.current = key;
      void (async () => {
        setSynthesizing(true);
        setError(null);
        try {
          const res = await fetch(`/api/groupchats/${encodeURIComponent(gc.groupchatId)}/synthesize`, {
            method: "POST",
          });
          if (!res.ok) {
            const j = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(j.error ?? `synthesis failed (${res.status})`);
          }
          const pollRes = await fetch(`/api/groupchats/${encodeURIComponent(gc.groupchatId)}`);
          if (pollRes.ok) {
            const j = (await pollRes.json()) as GroupchatState;
            setGc((prev) => (prev ? { ...prev, ...j } : prev));
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setSynthesizing(false);
        }
      })();
    }
  }, [
    gc?.groupchatId,
    gc?.roundsCompleted,
    gc?.currentRound,
    gc?.targetRounds,
    gc?.synthesis?.runId,
    crossTalking,
    synthesizing,
  ]);

  const accentColor = "#10b981"; // groupchat accent — green

  // ---- PICKER (no active groupchat) ----
  if (!gc) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {/* Agent picker — grouped by office */}
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-white/40">
            members (pick from any office)
          </div>
          <div className="flex flex-col gap-2">
            {Array.from(agentsByOffice.entries()).map(([slug, agents]) => {
              const officeName = allOffices.find((o) => o.slug === slug)?.name ?? slug;
              const accent = allOffices.find((o) => o.slug === slug)?.theme.accent ?? "#888";
              return (
                <div key={slug}>
                  <div className="mb-0.5 font-mono text-[9px] uppercase tracking-wider" style={{ color: accent + "99" }}>
                    {officeName}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {agents.map((a) => {
                      const on = picked.has(a.id);
                      return (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => togglePick(a.id)}
                          className={`rounded-sm border px-2 py-1 text-[11px] transition ${
                            on
                              ? "border-current text-zinc-100"
                              : "border-white/15 text-zinc-500 hover:text-zinc-300"
                          }`}
                          style={on ? { borderColor: accent, color: accent } : undefined}
                          title={a.role}
                        >
                          {a.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
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
            placeholder="What should they discuss?"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            autoFocus
          />
        </div>

        {/* Rounds */}
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
                    on ? "text-zinc-100" : "border-white/15 text-zinc-500 hover:text-zinc-300"
                  }`}
                  style={on ? { borderColor: accentColor, color: accentColor } : undefined}
                >
                  {n === 1 ? "1 round" : `${n} rounds`}
                </button>
              );
            })}
            <span className="ml-1 font-mono text-[10px] text-white/30">
              {targetRounds === 1
                ? "manual - you drive each round"
                : `runs ${targetRounds} rounds then synthesizes`}
            </span>
          </div>
        </div>

        {error && <div className="text-xs text-red-400">{error}</div>}

        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] text-white/40">
            {picked.size} agent{picked.size === 1 ? "" : "s"}
            {picked.size > 0 && (() => {
              const offices = new Set(Array.from(picked).map((id) => agentLookup.get(id)?.officeSlug));
              return offices.size > 1 ? " (cross-office)" : "";
            })()}
          </span>
          <button
            type="button"
            onClick={convene}
            disabled={submitting || !prompt.trim() || picked.size === 0}
            className="border px-3 py-1.5 font-mono text-xs uppercase tracking-wider transition disabled:cursor-not-allowed disabled:opacity-40"
            style={{ borderColor: accentColor, color: accentColor }}
          >
            {submitting ? "starting..." : "start groupchat"}
          </button>
        </div>
      </div>
    );
  }

  // ---- ACTIVE GROUPCHAT ----
  const autoRunning =
    gc.targetRounds > 1 &&
    (gc.roundsCompleted < gc.targetRounds || !gc.synthesis);
  const canCrossTalk =
    !autoRunning &&
    gc.currentRound > 0 &&
    gc.currentRound === gc.roundsCompleted &&
    !crossTalking &&
    !synthesizing &&
    gc.status !== "idle";

  const progressLabel = (() => {
    if (gc.status === "idle") return "idle (pinned)";
    if (gc.synthesis?.status === "done") return "synthesis ready";
    if (synthesizing || gc.synthesis?.status === "running" || gc.synthesis?.status === "starting") {
      return "synthesizing...";
    }
    if (gc.targetRounds > 1) {
      return `round ${gc.roundsCompleted}/${gc.targetRounds}${
        crossTalking ? " - advancing..." : gc.status === "done" ? " - settled" : " - running"
      }`;
    }
    return gc.roundsCompleted > 0
      ? `round ${gc.roundsCompleted} done`
      : gc.status === "done"
      ? "all done"
      : "in progress";
  })();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/5 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-white/40">
        <span>
          {gc.pinnedName ?? "groupchat"} - {gc.members.length} agents -{" "}
          {new Date(gc.convenedAt).toLocaleTimeString()}
        </span>
        <div className="flex items-center gap-2">
          <span
            style={{
              color:
                gc.synthesis?.status === "done" || (gc.status === "done" && !autoRunning)
                  ? accentColor
                  : gc.status === "idle"
                  ? "#71717a"
                  : "#fde047",
            }}
          >
            {progressLabel}
          </span>
          {/* Pin button */}
          {!gc.persistent && gc.status === "done" && (
            <button
              type="button"
              onClick={() => setShowPinInput(true)}
              className="border border-white/20 px-1.5 py-0.5 text-[9px] text-white/50 hover:text-white/80 transition"
              title="Pin this groupchat (make persistent)"
            >
              pin
            </button>
          )}
          {gc.persistent && (
            <span className="text-[9px]" style={{ color: accentColor }}>pinned</span>
          )}
        </div>
      </div>

      {/* Pin name input */}
      {showPinInput && (
        <div className="flex items-center gap-2 border-b border-white/5 px-3 py-2">
          <input
            type="text"
            value={pinName}
            onChange={(e) => setPinName(e.target.value)}
            placeholder="Name this groupchat (e.g. Bug Squad)"
            className="flex-1 border border-white/10 bg-black/50 px-2 py-1 font-mono text-xs text-white placeholder:text-white/25 focus:outline-none"
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") void pinGroupchat(); }}
          />
          <button
            type="button"
            onClick={() => void pinGroupchat()}
            disabled={!pinName.trim()}
            className="border px-2 py-1 font-mono text-[10px] uppercase disabled:opacity-40"
            style={{ borderColor: accentColor, color: accentColor }}
          >
            pin
          </button>
          <button
            type="button"
            onClick={() => { setShowPinInput(false); setPinName(""); }}
            className="font-mono text-[10px] text-white/40 hover:text-white/60"
          >
            cancel
          </button>
        </div>
      )}

      {error && <div className="border-b border-red-900/40 bg-red-950/30 px-3 py-1 text-xs text-red-400">{error}</div>}

      {/* Synthesis banner */}
      {gc.synthesis && (
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
            <span>&#9670; findings</span>
            <span className="opacity-70">
              {gc.synthesis.status === "done"
                ? "ready"
                : gc.synthesis.status === "error"
                ? "error"
                : "synthesizing..."}
            </span>
          </div>
          <div className="whitespace-pre-wrap text-[12px] leading-snug text-zinc-100">
            {gc.synthesis.text ?? (
              <span className="text-zinc-500">...synthesizing discussion</span>
            )}
          </div>
        </div>
      )}

      {/* Members grid */}
      <div className="grid flex-1 grid-cols-2 gap-px overflow-auto bg-white/5">
        {gc.members.map((mem) => {
          const meta = agentLookup.get(mem.agentId);
          const rounds = mem.runs.length > 0 ? mem.runs : [{ round: 1, runId: mem.runId ?? "", status: mem.runStatus, tailSnippet: mem.tailSnippet }];

          return (
            <div key={mem.agentId} className="flex flex-col gap-0 bg-zinc-950">
              <div className="flex items-baseline justify-between px-2 pt-2 pb-1">
                <div>
                  <div className="text-sm text-zinc-100">{meta?.name ?? mem.agentId}</div>
                  <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                    {meta?.role ?? ""}{meta?.officeName ? ` - ${meta.officeName}` : ""}
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-px">
                {rounds.map((run) => {
                  const color = statusColor(run.status);
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
                        {run.tailSnippet ?? <span className="text-zinc-600">...waiting</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Input bar */}
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
            gc.status === "idle"
              ? "post a new topic to restart..."
              : autoRunning
              ? "auto-run in progress..."
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
          disabled={!canCrossTalk && gc.status !== "idle"}
          className="shrink-0 rounded border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider transition disabled:cursor-not-allowed disabled:opacity-30"
          style={{ borderColor: accentColor + "99", color: accentColor }}
        >
          {crossTalking ? "..." : roundMessage.trim() ? "send" : gc.status === "idle" ? "restart" : "next round"}
        </button>
      </div>
    </div>
  );
}
