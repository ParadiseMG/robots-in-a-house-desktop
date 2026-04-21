"use client";

import { useState } from "react";
import { useVisibleInterval } from "@/hooks/useVisibleInterval";

type AgentStatus = { agentId: string; officeSlug: string; status: string };

type GroupchatSummary = {
  groupchatId: string;
  convenedBy: string;
  prompt: string;
  convenedAt: number;
  persistent: boolean;
  pinnedName: string | null;
  status: "running" | "done" | "idle";
  memberCount: number;
  agentStatuses: AgentStatus[];
};

type Props = {
  agentNames: ReadonlyMap<string, string>;
  officeNames: ReadonlyMap<string, string>;
  officeAccents: ReadonlyMap<string, string>;
  onOpen: (groupchatId: string) => void;
};

const POLL_MS = 3000;

function statusDot(status: string): string {
  if (status === "running" || status === "starting") return "#7dd3fc";
  if (status === "awaiting_input") return "#fde047";
  if (status === "done") return "#34d399";
  if (status === "error") return "#f87171";
  if (status === "idle") return "#71717a";
  return "#71717a";
}

export default function ActiveGroupchats({ agentNames, officeNames, officeAccents, onOpen }: Props) {
  const [groupchats, setGroupchats] = useState<GroupchatSummary[]>([]);
  const [collapsed, setCollapsed] = useState(false);

  useVisibleInterval(() => {
    fetch("/api/groupchats?status=recent")
      .then((r) => r.ok ? r.json() as Promise<{ groupchats: GroupchatSummary[] }> : null)
      .then((j) => { if (j) setGroupchats(j.groupchats); })
      .catch(() => {});
  }, POLL_MS);

  if (groupchats.length === 0) return null;

  const accentColor = "#10b981";

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="group flex items-center gap-1 px-2 font-mono text-[9px] uppercase tracking-widest text-white/30 hover:text-white/50 transition-colors"
      >
        <span
          className="inline-block transition-transform duration-200"
          style={{ transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)" }}
        >
          &#9662;
        </span>
        groupchats
        {collapsed && (
          <span className="ml-1 tabular-nums text-white/20">({groupchats.length})</span>
        )}
      </button>
      {!collapsed && groupchats.map((gc) => {
        const isActive = gc.status === "running";
        const isPinned = gc.persistent;

        // Determine which offices are involved
        const officesInvolved = new Set(gc.agentStatuses.map((a) => a.officeSlug));
        const isCrossOffice = officesInvolved.size > 1;

        return (
          <button
            key={gc.groupchatId}
            type="button"
            onClick={() => onOpen(gc.groupchatId)}
            className="group flex flex-col gap-1 rounded border border-white/8 bg-white/[0.02] px-2.5 py-2 text-left transition hover:bg-white/[0.06]"
          >
            <div className="flex items-center gap-1.5">
              {isActive && (
                <span
                  className="inline-block h-1.5 w-1.5 animate-pulse rounded-full"
                  style={{ backgroundColor: accentColor }}
                />
              )}
              {isPinned && (
                <span className="font-mono text-[9px]" style={{ color: accentColor }}>
                  &#9733;
                </span>
              )}
              <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: accentColor }}>
                {gc.pinnedName ?? (isCrossOffice ? "cross-office" : Array.from(officesInvolved).map((s) => officeNames.get(s) ?? s).join(", "))}
              </span>
              <span className="ml-auto font-mono text-[9px] text-white/25">
                {gc.status === "idle" ? "idle" : new Date(gc.convenedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
            <div className="text-[11px] leading-tight text-white/60 group-hover:text-white/80">
              {gc.prompt}
            </div>
            <div className="flex items-center gap-1.5">
              {gc.agentStatuses.map((a) => (
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
