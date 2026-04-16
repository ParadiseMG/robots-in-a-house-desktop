"use client";

import { useEffect, useRef, useState } from "react";

type SynthesisNotification = {
  kind: "synthesis";
  runId: string;
  status: "done" | "error";
  at: number;
  officeSlug: string;
  meetingId: string;
  promptSnippet: string;
};

type AgentRunNotification = {
  kind: "agent_run";
  runId: string;
  status: "done" | "error";
  at: number;
  officeSlug: string;
  agentId: string;
  agentName: string;
  agentRole: string;
};

type AwaitingInputNotification = {
  kind: "awaiting_input";
  runId: string;
  at: number;
  officeSlug: string;
  agentId: string;
  agentName: string;
  agentRole: string;
};

type Notification =
  | SynthesisNotification
  | AgentRunNotification
  | AwaitingInputNotification;

const URGENT_COLOR = "#fde047"; // amber — matches the `!` desk indicator

type Props = {
  officeNames: ReadonlyMap<string, string>;
  officeAccents: ReadonlyMap<string, string>;
  /** Open a war room tab for the given meeting. */
  onOpenWarRoom: (officeSlug: string, meetingId: string) => void;
  /** Focus the chat for this agent. */
  onOpenAgent: (officeSlug: string, agentId: string) => void;
};

const POLL_MS = 3000;

/** Two-tone ping using Web Audio — "done" is soft, "urgent" is higher + louder. */
function playPing(variant: "done" | "urgent" = "done") {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const tone = (freq: number, start: number, dur: number, vol: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + start);
      gain.gain.linearRampToValueAtTime(vol, now + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur + 0.05);
    };

    if (variant === "urgent") {
      // Three ascending notes, louder — "hey, you" attention
      tone(784, 0, 0.12, 0.11); // G5
      tone(1047, 0.1, 0.12, 0.11); // C6
      tone(1319, 0.2, 0.22, 0.12); // E6
    } else {
      // Two-note rising: A5 → D6 (soft)
      tone(880, 0, 0.14, 0.08);
      tone(1174, 0.1, 0.2, 0.08);
    }

    setTimeout(() => {
      void ctx.close();
    }, 700);
  } catch {
    // silent fallback
  }
}

function timeLabel(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function NotificationCenter({
  officeNames,
  officeAccents,
  onOpenWarRoom,
  onOpenAgent,
}: Props) {
  const [notifs, setNotifs] = useState<Notification[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const firstLoadRef = useRef(true);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/notifications");
        if (!res.ok) return;
        const j = (await res.json()) as { notifications: Notification[] };
        if (!alive) return;

        // Ping if any new notifications arrived since last tick — louder for urgent
        if (!firstLoadRef.current) {
          const newOnes = j.notifications.filter(
            (n) => !seenIdsRef.current.has(n.runId),
          );
          if (newOnes.length > 0) {
            const hasUrgent = newOnes.some((n) => n.kind === "awaiting_input");
            playPing(hasUrgent ? "urgent" : "done");
          }
        }
        seenIdsRef.current = new Set(j.notifications.map((n) => n.runId));
        firstLoadRef.current = false;

        // Sort: awaiting_input first (urgent), then by recency DESC
        const sorted = [...j.notifications].sort((a, b) => {
          const aUrgent = a.kind === "awaiting_input" ? 0 : 1;
          const bUrgent = b.kind === "awaiting_input" ? 0 : 1;
          if (aUrgent !== bUrgent) return aUrgent - bUrgent;
          return b.at - a.at;
        });
        setNotifs(sorted);
      } catch {
        // ignore
      }
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const dismiss = async (runId: string) => {
    // Optimistic
    setNotifs((prev) => prev.filter((n) => n.runId !== runId));
    try {
      await fetch(`/api/runs/${encodeURIComponent(runId)}/ack`, {
        method: "POST",
      });
    } catch {
      // if ack fails, it'll reappear next poll — acceptable
    }
  };

  const dismissAll = async () => {
    // Only dismiss non-urgent items — awaiting_input clears when the user replies
    const dismissable = notifs.filter((n) => n.kind !== "awaiting_input");
    const ids = dismissable.map((n) => n.runId);
    setNotifs((prev) => prev.filter((n) => n.kind === "awaiting_input"));
    await Promise.all(
      ids.map((id) =>
        fetch(`/api/runs/${encodeURIComponent(id)}/ack`, { method: "POST" }).catch(
          () => undefined,
        ),
      ),
    );
  };

  const handleOpen = (n: Notification) => {
    if (n.kind === "synthesis") {
      onOpenWarRoom(n.officeSlug, n.meetingId);
      void dismiss(n.runId);
    } else if (n.kind === "agent_run") {
      onOpenAgent(n.officeSlug, n.agentId);
      void dismiss(n.runId);
    } else {
      // awaiting_input — open chat so user can reply; do NOT ack (still active)
      onOpenAgent(n.officeSlug, n.agentId);
    }
  };

  const urgentCount = notifs.filter((n) => n.kind === "awaiting_input").length;
  const dismissableCount = notifs.length - urgentCount;

  if (notifs.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between px-2">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="font-mono text-[9px] uppercase tracking-widest hover:text-white/70"
          style={{ color: urgentCount > 0 ? URGENT_COLOR : "rgba(255,255,255,0.4)" }}
          title={collapsed ? "expand" : "collapse"}
        >
          {urgentCount > 0 ? "▲" : "●"} notifications · {notifs.length}
          {urgentCount > 0 && (
            <span className="ml-1 opacity-80">· {urgentCount} urgent</span>
          )}
        </button>
        {!collapsed && dismissableCount > 1 && (
          <button
            type="button"
            onClick={() => void dismissAll()}
            className="font-mono text-[9px] uppercase tracking-wider text-white/30 hover:text-white/60"
          >
            clear done
          </button>
        )}
      </div>

      {!collapsed &&
        notifs.map((n) => {
          const accent = officeAccents.get(n.officeSlug) ?? "#10b981";
          const officeName = officeNames.get(n.officeSlug) ?? n.officeSlug;
          const isUrgent = n.kind === "awaiting_input";
          const isError = n.kind !== "awaiting_input" && n.status === "error";

          // Color + label per kind
          const dotColor = isUrgent
            ? URGENT_COLOR
            : isError
            ? "#f87171"
            : accent;
          const labelColor = dotColor;
          const borderColor = isUrgent
            ? URGENT_COLOR + "88"
            : isError
            ? "#f8717166"
            : accent + "55";
          const bgColor = isUrgent
            ? `${URGENT_COLOR}11`
            : "rgba(255,255,255,0.02)";
          const labelText =
            n.kind === "awaiting_input"
              ? "awaiting you"
              : n.kind === "synthesis"
              ? "findings ready"
              : isError
              ? "error"
              : "done";
          const bodyText =
            n.kind === "synthesis"
              ? n.promptSnippet
              : `${n.agentName} — ${n.agentRole}`;

          return (
            <div
              key={n.runId}
              className={`group relative flex flex-col gap-1 rounded border px-2.5 py-2 transition hover:bg-white/[0.06] ${
                isUrgent ? "shadow-[0_0_0_1px_rgba(253,224,71,0.25)]" : ""
              }`}
              style={{ borderColor, background: bgColor }}
            >
              <button
                type="button"
                onClick={() => handleOpen(n)}
                className="flex flex-col gap-1 text-left"
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={`inline-block h-1.5 w-1.5 rounded-full ${
                      isUrgent ? "animate-pulse" : ""
                    }`}
                    style={{ backgroundColor: dotColor }}
                  />
                  <span
                    className="font-mono text-[10px] uppercase tracking-wider"
                    style={{ color: labelColor }}
                  >
                    {labelText}
                  </span>
                  <span className="font-mono text-[9px] text-white/30">
                    · {officeName}
                  </span>
                  <span className="ml-auto font-mono text-[9px] text-white/25">
                    {timeLabel(n.at)}
                  </span>
                </div>
                <div
                  className={`text-[11px] leading-tight ${
                    isUrgent
                      ? "text-zinc-100"
                      : "text-white/70 group-hover:text-white/90"
                  }`}
                >
                  {bodyText}
                </div>
                {isUrgent && (
                  <div className="mt-0.5 font-mono text-[9px] uppercase tracking-wider text-white/50">
                    click to reply →
                  </div>
                )}
              </button>
              {!isUrgent && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void dismiss(n.runId);
                  }}
                  className="absolute right-1 top-1 rounded px-1 font-mono text-[10px] leading-none text-white/25 opacity-0 transition hover:text-white/80 group-hover:opacity-100"
                  title="dismiss"
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
    </div>
  );
}
