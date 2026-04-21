"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDockTabs } from "@/hooks/useDockTabs";
import type { OfficeConfig } from "@/lib/office-types";

// ---- Types ----

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

type TimelineEntry =
  | {
      type: "agent";
      agentId: string;
      agentName: string;
      agentRole: string;
      officeSlug: string;
      round: number;
      runId: string;
      status: string;
      text: string | null;
      ts: number;
    }
  | {
      type: "user";
      messageId: string;
      text: string;
      ts: number;
      deliveredInRound: number | null;
    }
  | {
      type: "system";
      text: string;
      ts: number;
    };

type Props = {
  tabId: string;
  allOffices: OfficeConfig[];
};

const POLL_MS = 1500;
const TIMELINE_POLL_MS = 2000;

function statusColor(runStatus: string): string {
  if (runStatus === "done") return "#34d399";
  if (runStatus === "error") return "#f87171";
  if (runStatus === "awaiting_input") return "#fde047";
  if (runStatus === "running") return "#7dd3fc";
  if (runStatus === "idle") return "#71717a";
  return "#a1a1aa";
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return new Date(ts).toLocaleTimeString();
}

// ---- Conversation View ----

function ConversationView({
  gc,
  timeline,
  agentLookup,
  allOffices,
  onSendMessage,
  onNextRound,
  onPin,
  onClose,
  crossTalking,
  synthesizing,
  error,
}: {
  gc: GroupchatState;
  timeline: TimelineEntry[];
  agentLookup: Map<string, { name: string; role: string; officeSlug: string; officeName: string }>;
  allOffices: OfficeConfig[];
  onSendMessage: (text: string) => Promise<void>;
  onNextRound: (message?: string) => Promise<void>;
  onPin: () => void;
  onClose: () => void;
  crossTalking: boolean;
  synthesizing: boolean;
  error: string | null;
}) {
  const [inputText, setInputText] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLenRef = useRef(0);

  const accentColor = "#10b981";

  // Auto-scroll when new entries arrive
  useEffect(() => {
    if (timeline.length > prevLenRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevLenRef.current = timeline.length;
  }, [timeline.length]);

  const roundSettled =
    gc.currentRound > 0 && gc.currentRound === gc.roundsCompleted;

  // Connor drives every round — can advance when the current round is settled
  const canAdvanceRound =
    roundSettled && !crossTalking && !synthesizing && gc.status !== "idle";

  // Send a user message (always available)
  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text) return;
    setSending(true);
    try {
      await onSendMessage(text);
      setInputText("");
    } finally {
      setSending(false);
    }
  }, [inputText, onSendMessage]);

  // Send + advance round
  const handleSendAndAdvance = useCallback(async () => {
    const text = inputText.trim();
    setSending(true);
    try {
      await onNextRound(text || undefined);
      setInputText("");
    } finally {
      setSending(false);
    }
  }, [inputText, onNextRound]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (canAdvanceRound) {
          void handleSendAndAdvance();
        } else {
          void handleSend();
        }
      }
    },
    [canAdvanceRound, handleSendAndAdvance, handleSend],
  );

  // Group consecutive agent entries from same round for visual clustering
  const getOfficeAccent = (officeSlug: string) => {
    return allOffices.find((o) => o.slug === officeSlug)?.theme.accent ?? "#888";
  };

  const progressLabel = (() => {
    if (gc.status === "idle") return "idle (pinned)";
    if (crossTalking) return "advancing...";
    if (roundSettled) return `round ${gc.roundsCompleted} done — your turn`;
    return `round ${gc.currentRound} — agents responding`;
  })();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/5 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-white/40">
            {gc.pinnedName ?? "groupchat"} - {gc.members.length} agents
          </span>
          {/* Member status dots */}
          <div className="flex items-center gap-1">
            {gc.members.map((mem) => {
              const meta = agentLookup.get(mem.agentId);
              return (
                <div
                  key={mem.agentId}
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: statusColor(mem.runStatus) }}
                  title={`${meta?.name ?? mem.agentId}: ${mem.runStatus}`}
                />
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="font-mono text-[10px]"
            style={{
              color: roundSettled
                ? accentColor
                : gc.status === "idle"
                ? "#71717a"
                : "#fde047",
            }}
          >
            {progressLabel}
          </span>
          {/* Pin button */}
          {!gc.persistent && roundSettled && (
            <button
              type="button"
              onClick={onPin}
              className="border border-white/20 px-1.5 py-0.5 font-mono text-[9px] text-white/50 transition hover:text-white/80"
              title="Pin this groupchat"
            >
              pin
            </button>
          )}
          {gc.persistent && (
            <span className="font-mono text-[9px]" style={{ color: accentColor }}>
              pinned
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="border-b border-red-900/40 bg-red-950/30 px-3 py-1 text-xs text-red-400">
          {error}
        </div>
      )}

      {/* Timeline — conversation view */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2">
        <div className="flex flex-col gap-2">
          {timeline.map((entry, i) => {
            if (entry.type === "system") {
              return (
                <div key={`sys-${i}`} className="py-1 text-center font-mono text-[10px] text-white/30">
                  {entry.text}
                </div>
              );
            }

            if (entry.type === "user") {
              return (
                <div key={entry.messageId} className="flex justify-end">
                  <div className="max-w-[85%]">
                    <div className="flex items-baseline justify-end gap-2">
                      <span className="font-mono text-[9px] text-white/30">
                        {relativeTime(entry.ts)}
                      </span>
                      <span className="text-[11px] font-medium text-blue-400">Connor</span>
                    </div>
                    <div className="mt-0.5 rounded-lg rounded-tr-sm border border-blue-500/30 bg-blue-950/40 px-3 py-2 text-[12px] leading-snug text-zinc-100">
                      {entry.text}
                    </div>
                    {entry.deliveredInRound == null && (
                      <div className="mt-0.5 text-right font-mono text-[9px] text-yellow-500/60">
                        queued for next round
                      </div>
                    )}
                  </div>
                </div>
              );
            }

            // Agent message
            const accent = getOfficeAccent(entry.officeSlug);
            const isRunning = entry.status === "running" || entry.status === "starting";
            return (
              <div key={`${entry.runId}-${entry.round}`} className="flex">
                <div className="max-w-[85%]">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[11px] font-medium" style={{ color: accent }}>
                      {entry.agentName}
                    </span>
                    <span className="font-mono text-[9px] text-white/25">
                      {entry.agentRole}
                    </span>
                    <span className="font-mono text-[9px] text-white/20">
                      R{entry.round}
                    </span>
                    <span className="font-mono text-[9px] text-white/30">
                      {relativeTime(entry.ts)}
                    </span>
                  </div>
                  <div
                    className="mt-0.5 rounded-lg rounded-tl-sm border px-3 py-2 text-[12px] leading-snug text-zinc-200"
                    style={{
                      borderColor: isRunning ? accent + "40" : "rgba(255,255,255,0.07)",
                      backgroundColor: isRunning ? accent + "08" : "rgba(255,255,255,0.03)",
                    }}
                  >
                    {entry.text ?? (
                      <span className="text-zinc-500">
                        {isRunning ? (
                          <span className="animate-pulse">thinking...</span>
                        ) : entry.status === "error" ? (
                          "error"
                        ) : (
                          "waiting..."
                        )}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Typing indicator when round is running */}
          {gc.status === "running" && !roundSettled && (
            <div className="py-1 text-center font-mono text-[10px] text-white/25 animate-pulse">
              agents are responding...
            </div>
          )}
        </div>
      </div>

      {/* Input bar — always active */}
      <div className="border-t border-white/10 px-3 py-2">
        <div className="flex items-end gap-2">
          <textarea
            rows={1}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={sending}
            placeholder={
              gc.status === "idle"
                ? "type to restart this groupchat..."
                : canAdvanceRound
                ? "type a message and hit enter to advance round..."
                : "type a message... (queued for next round)"
            }
            className="flex-1 resize-none rounded border border-white/10 bg-black/50 px-2 py-1.5 font-mono text-xs text-white placeholder:text-white/25 focus:border-white/25 focus:outline-none disabled:opacity-40"
            style={{ maxHeight: 80 }}
          />
          <div className="flex shrink-0 flex-col gap-1">
            {/* Primary action: send message (always available) */}
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={sending || !inputText.trim()}
              className="rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition disabled:cursor-not-allowed disabled:opacity-30"
              style={{ borderColor: "#3b82f6" + "99", color: "#3b82f6" }}
              title="Send message (queued for next round if agents are running)"
            >
              {sending ? "..." : "send"}
            </button>
            {/* Secondary: advance round */}
            {canAdvanceRound && (
              <button
                type="button"
                onClick={() => void handleSendAndAdvance()}
                disabled={sending || crossTalking}
                className="rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition disabled:cursor-not-allowed disabled:opacity-30"
                style={{ borderColor: accentColor + "99", color: accentColor }}
                title="Send message + advance to next round"
              >
                {crossTalking ? "..." : "next round"}
              </button>
            )}
          </div>
        </div>
        {!canAdvanceRound && inputText.trim() && gc.status === "running" && (
          <div className="mt-1 font-mono text-[9px] text-yellow-500/50">
            message will be included in the next round
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Main Component ----

export default function GroupchatTab({ tabId, allOffices }: Props) {
  const { dispatch, tabs } = useDockTabs();
  const thisTab = tabs.find((t) => t.id === tabId);
  const persistedGroupchatId = thisTab?.groupchatId ?? null;

  // All agents from all offices for the picker
  const allAgents = useMemo(() => {
    const agents: Array<{
      id: string;
      name: string;
      role: string;
      officeSlug: string;
      officeName: string;
      isReal: boolean;
      deskId: string;
    }> = [];
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

  const agentLookup = useMemo(() => {
    const m = new Map<
      string,
      { name: string; role: string; officeSlug: string; officeName: string }
    >();
    for (const a of allAgents) m.set(a.id, a);
    return m;
  }, [allAgents]);

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
  const targetRounds = 1; // Connor drives every round manually
  const [submitting, setSubmitting] = useState(false);
  const [crossTalking, setCrossTalking] = useState(false);
  const synthesizing = false; // synthesis removed — Connor drives rounds manually
  const [error, setError] = useState<string | null>(null);
  const [gc, setGc] = useState<GroupchatState | null>(null);
  const [pinName, setPinName] = useState("");
  const [showPinInput, setShowPinInput] = useState(false);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);

  // Hydrate from persisted groupchatId
  useEffect(() => {
    if (gc || !persistedGroupchatId) return;
    (async () => {
      try {
        const res = await fetch(
          `/api/groupchats/${encodeURIComponent(persistedGroupchatId)}`,
        );
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
        members: Array<{
          agentId: string;
          officeSlug: string;
          assignmentId: string;
          runId: string | null;
        }>;
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
      dispatch({
        type: "SET_GROUPCHAT_ID",
        id: tabId,
        groupchatId: j.groupchatId,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  // Send a user message (available anytime)
  const sendMessage = useCallback(
    async (text: string) => {
      if (!gc) return;
      setError(null);
      try {
        const res = await fetch(
          `/api/groupchats/${encodeURIComponent(gc.groupchatId)}/message`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
          },
        );
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `send failed (${res.status})`);
        }
        // Immediately add to timeline for instant feedback
        const j = (await res.json()) as { messageId: string; sentAt: number };
        setTimeline((prev) => [
          ...prev,
          { type: "user", messageId: j.messageId, text, ts: j.sentAt, deliveredInRound: null },
        ]);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [gc],
  );

  // Advance round (with optional message)
  const crossTalk = useCallback(
    async (message?: string) => {
      if (!gc) return;
      setCrossTalking(true);
      setError(null);
      try {
        const body: Record<string, string> = {};
        if (message?.trim()) body.message = message.trim();
        const res = await fetch(
          `/api/groupchats/${encodeURIComponent(gc.groupchatId)}/round`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `round failed (${res.status})`);
        }
        // Refresh state
        const pollRes = await fetch(
          `/api/groupchats/${encodeURIComponent(gc.groupchatId)}`,
        );
        if (pollRes.ok) {
          const j = (await pollRes.json()) as GroupchatState;
          setGc((prev) => (prev ? { ...prev, ...j } : prev));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setCrossTalking(false);
      }
    },
    [gc],
  );

  const pinGroupchat = async () => {
    if (!gc || !pinName.trim()) return;
    try {
      const res = await fetch(
        `/api/groupchats/${encodeURIComponent(gc.groupchatId)}/pin`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: pinName.trim() }),
        },
      );
      if (res.ok) {
        setGc((prev) =>
          prev
            ? { ...prev, persistent: true, pinnedName: pinName.trim() }
            : prev,
        );
        setShowPinInput(false);
        setPinName("");
      }
    } catch {}
  };

  const closeGroupchat = async () => {
    if (!gc) return;
    try {
      await fetch(
        `/api/groupchats/${encodeURIComponent(gc.groupchatId)}/close`,
        { method: "POST" },
      );
      setGc((prev) => (prev ? { ...prev, status: "idle" } : prev));
    } catch {}
  };

  // Poll groupchat state
  useEffect(() => {
    if (!gc) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(
          `/api/groupchats/${encodeURIComponent(gc.groupchatId)}`,
        );
        if (!res.ok) return;
        const j = (await res.json()) as GroupchatState;
        if (cancelled) return;
        setGc((prev) => (prev ? { ...prev, ...j } : prev));
      } catch {}
    };
    void tick();
    const id = setInterval(() => {
      if (gc.status === "idle") return;
      void tick();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [
    gc?.groupchatId,
    gc?.status,
    gc?.synthesis?.status,
    gc?.roundsCompleted,
    gc?.targetRounds,
  ]);

  // Poll timeline
  useEffect(() => {
    if (!gc) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(
          `/api/groupchats/${encodeURIComponent(gc.groupchatId)}/timeline`,
        );
        if (!res.ok) return;
        const j = (await res.json()) as { timeline: TimelineEntry[] };
        if (cancelled) return;
        setTimeline(j.timeline);
      } catch {}
    };
    void tick();
    const id = setInterval(tick, TIMELINE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [gc?.groupchatId]);

  // No auto-advance — Connor drives every round manually via Send / Next Round.

  const accentColor = "#10b981";

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
              const officeName =
                allOffices.find((o) => o.slug === slug)?.name ?? slug;
              const accent =
                allOffices.find((o) => o.slug === slug)?.theme.accent ?? "#888";
              return (
                <div key={slug}>
                  <div
                    className="mb-0.5 font-mono text-[9px] uppercase tracking-wider"
                    style={{ color: accent + "99" }}
                  >
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
                          style={
                            on
                              ? { borderColor: accent, color: accent }
                              : undefined
                          }
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

        {error && <div className="text-xs text-red-400">{error}</div>}

        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] text-white/40">
            {picked.size} agent{picked.size === 1 ? "" : "s"}
            {picked.size > 0 &&
              (() => {
                const offices = new Set(
                  Array.from(picked).map(
                    (id) => agentLookup.get(id)?.officeSlug,
                  ),
                );
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

  // ---- ACTIVE GROUPCHAT — Conversation View ----
  return (
    <>
      <ConversationView
        gc={gc}
        timeline={timeline}
        agentLookup={agentLookup}
        allOffices={allOffices}
        onSendMessage={sendMessage}
        onNextRound={crossTalk}
        onPin={() => setShowPinInput(true)}
        onClose={closeGroupchat}
        crossTalking={crossTalking}
        synthesizing={synthesizing}
        error={error}
      />
      {/* Pin dialog overlay */}
      {showPinInput && (
        <div className="absolute inset-x-0 bottom-0 border-t border-white/10 bg-zinc-950 px-3 py-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={pinName}
              onChange={(e) => setPinName(e.target.value)}
              placeholder="Name this groupchat (e.g. Bug Squad)"
              className="flex-1 border border-white/10 bg-black/50 px-2 py-1 font-mono text-xs text-white placeholder:text-white/25 focus:outline-none"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") void pinGroupchat();
              }}
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
              onClick={() => {
                setShowPinInput(false);
                setPinName("");
              }}
              className="font-mono text-[10px] text-white/40 hover:text-white/60"
            >
              cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}
