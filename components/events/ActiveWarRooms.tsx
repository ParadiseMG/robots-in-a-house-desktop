"use client";

import { useEffect, useState } from "react";

type AgentStatus = { agentId: string; status: string };

type WarRoomSummary = {
  meetingId: string;
  officeSlug: string;
  convenedBy: string;
  prompt: string;
  convenedAt: number;
  status: "running" | "done";
  attendeeCount: number;
  agentStatuses: AgentStatus[];
};

type Props = {
  agentNames: ReadonlyMap<string, string>;
  officeNames: ReadonlyMap<string, string>;
  officeAccents: ReadonlyMap<string, string>;
  onOpen: (officeSlug: string, meetingId: string) => void;
};

const POLL_MS = 3000;

function statusDot(status: string): string {
  if (status === "running" || status === "starting") return "#7dd3fc";
  if (status === "awaiting_input") return "#fde047";
  if (status === "done") return "#34d399";
  if (status === "error") return "#f87171";
  return "#71717a";
}

export default function ActiveWarRooms({ agentNames, officeNames, officeAccents, onOpen }: Props) {
  const [meetings, setMeetings] = useState<WarRoomSummary[]>([]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/war-room?status=recent");
        if (!res.ok) return;
        const j = (await res.json()) as { meetings: WarRoomSummary[] };
        if (alive) setMeetings(j.meetings);
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

  if (meetings.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      <div className="px-2 font-mono text-[9px] uppercase tracking-widest text-white/30">
        war rooms
      </div>
      {meetings.map((m) => {
        const accent = officeAccents.get(m.officeSlug) ?? "#10b981";
        const officeName = officeNames.get(m.officeSlug) ?? m.officeSlug;
        const isActive = m.status === "running";

        return (
          <button
            key={m.meetingId}
            type="button"
            onClick={() => onOpen(m.officeSlug, m.meetingId)}
            className="group flex flex-col gap-1 rounded border border-white/8 bg-white/[0.02] px-2.5 py-2 text-left transition hover:bg-white/[0.06]"
          >
            <div className="flex items-center gap-1.5">
              {isActive && (
                <span
                  className="inline-block h-1.5 w-1.5 animate-pulse rounded-full"
                  style={{ backgroundColor: accent }}
                />
              )}
              <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: accent }}>
                {officeName}
              </span>
              <span className="ml-auto font-mono text-[9px] text-white/25">
                {new Date(m.convenedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
            <div className="text-[11px] leading-tight text-white/60 group-hover:text-white/80">
              {m.prompt}
            </div>
            <div className="flex items-center gap-1.5">
              {m.agentStatuses.map((a) => (
                <span key={a.agentId} className="flex items-center gap-0.5">
                  <span
                    className="inline-block h-1 w-1 rounded-full"
                    style={{ backgroundColor: statusDot(a.status) }}
                  />
                  <span className="font-mono text-[9px] text-white/35">
                    {agentNames.get(a.agentId) ?? a.agentId}
                  </span>
                </span>
              ))}
            </div>
          </button>
        );
      })}
    </div>
  );
}
