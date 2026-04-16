"use client";

import { useEffect, useRef, useState } from "react";
import { useDockTabs, type DockTab } from "@/hooks/useDockTabs";

type AgentStatus = { agentId: string; status: string };
type WarRoomSummary = {
  meetingId: string;
  status: "running" | "done";
  agentStatuses: AgentStatus[];
};

function aggregateWarRoomStatus(agentStatuses: AgentStatus[]): string {
  if (agentStatuses.some((a) => a.status === "error")) return "error";
  if (agentStatuses.some((a) => a.status === "awaiting_input")) return "awaiting_input";
  if (agentStatuses.some((a) => a.status === "running" || a.status === "starting")) return "running";
  if (agentStatuses.length > 0 && agentStatuses.every((a) => a.status === "done")) return "done";
  return "idle";
}

function useWarRoomStatuses(): ReadonlyMap<string, string> {
  const [statusMap, setStatusMap] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/war-room?status=recent", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as { meetings: WarRoomSummary[] };
        if (!alive) return;
        const m = new Map<string, string>();
        for (const meeting of j.meetings) {
          m.set(meeting.meetingId, aggregateWarRoomStatus(meeting.agentStatuses));
        }
        setStatusMap(m);
      } catch { /* ignore */ }
    };
    void tick();
    const id = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return statusMap;
}

type Props = {
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenPicker: () => void;
  deskRunStatus?: ReadonlyMap<string, string>;
  onAckDesk?: (deskId: string) => void;
};

function tabStateColor(status: string | undefined): {
  border: string;
  text: string;
  dot: string | null;
} {
  switch (status) {
    case "awaiting_input":
      return { border: "border-l-amber-400", text: "text-amber-300", dot: "bg-amber-400 animate-pulse" };
    case "done_unacked":
      return { border: "border-l-emerald-500", text: "text-emerald-300", dot: "bg-emerald-500" };
    case "error":
      return { border: "border-l-red-500", text: "text-red-400", dot: "bg-red-500" };
    case "running":
    case "starting":
      return { border: "border-l-sky-500", text: "text-sky-300", dot: "bg-sky-400 animate-pulse" };
    default:
      return { border: "border-l-transparent", text: "", dot: null };
  }
}

function TabButton({
  tab,
  focused,
  onFocus,
  onClose,
  runStatus,
}: {
  tab: DockTab;
  focused: boolean;
  onFocus: () => void;
  onClose: () => void;
  runStatus?: string;
}) {
  const state = tabStateColor(runStatus);
  return (
    <button
      type="button"
      onClick={onFocus}
      className={`group flex h-full min-w-0 max-w-[160px] items-center gap-1.5 border-l-2 border-r border-r-white/10 px-3 font-mono text-[10px] uppercase tracking-wider transition-colors ${state.border} ${
        focused
          ? `bg-black/60 ${state.text || "text-white"}`
          : `hover:bg-white/5 ${state.text ? state.text + "/80" : "text-white/50 hover:text-white/80"}`
      }`}
      title={tab.label}
    >
      {tab.kind === "war-room" && (
        <span className="shrink-0 text-[9px] opacity-60">⚔</span>
      )}
      {state.dot && (
        <span className={`shrink-0 h-1.5 w-1.5 rounded-full ${state.dot}`} />
      )}
      <span className="truncate">{tab.label}</span>
      {!tab.pinned && (
        <span
          role="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="ml-auto shrink-0 rounded px-0.5 text-[10px] text-white/30 opacity-0 group-hover:opacity-100 hover:text-white"
          aria-label={`Close ${tab.label}`}
        >
          ✕
        </span>
      )}
    </button>
  );
}

export default function TabStrip({
  collapsed,
  onToggleCollapse,
  onOpenPicker,
  deskRunStatus,
  onAckDesk,
}: Props) {
  const { tabs, focusedId, focus, close, reorder } = useDockTabs();
  const warRoomStatuses = useWarRoomStatuses();
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);

  // Cmd+1/2/3 shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      const n = parseInt(e.key);
      if (isNaN(n) || n < 1 || n > tabs.length) return;
      const target = tabs[n - 1];
      if (target) {
        e.preventDefault();
        focus(target.id);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [tabs, focus]);

  return (
    <div className="flex h-9 min-h-9 w-full items-stretch border-b border-white/10">
      {/* Collapse toggle */}
      <button
        type="button"
        onClick={onToggleCollapse}
        className="flex w-8 shrink-0 items-center justify-center border-r border-white/10 text-white/40 hover:bg-white/5 hover:text-white"
        title={collapsed ? "Expand dock" : "Collapse dock"}
        aria-label={collapsed ? "Expand dock" : "Collapse dock"}
      >
        <span className="text-[10px]">{collapsed ? "▲" : "▼"}</span>
      </button>

      {/* Tab list */}
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {tabs.map((tab) => {
          const runStatus =
            tab.kind === "1:1"
              ? (tab.deskId ? deskRunStatus?.get(tab.deskId) : undefined)
              : (tab.meetingId ? warRoomStatuses.get(tab.meetingId) : undefined);
          return (
            <div
              key={tab.id}
              className="relative flex h-full items-stretch"
              draggable
              onDragStart={(e) => {
                dragIdRef.current = tab.id;
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", tab.id);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dragIdRef.current !== tab.id) setDragOverId(tab.id);
              }}
              onDragLeave={() => setDragOverId(null)}
              onDrop={(e) => {
                e.preventDefault();
                const fromId = dragIdRef.current;
                if (fromId && fromId !== tab.id) reorder(fromId, tab.id);
                setDragOverId(null);
                dragIdRef.current = null;
              }}
              onDragEnd={() => {
                setDragOverId(null);
                dragIdRef.current = null;
              }}
            >
              {dragOverId === tab.id && (
                <div className="pointer-events-none absolute inset-y-1 left-0 w-0.5 rounded-full bg-white/60" />
              )}
              <TabButton
                tab={tab}
                focused={tab.id === focusedId}
                onFocus={() => {
                focus(tab.id);
                if (runStatus === "done_unacked" && tab.deskId) onAckDesk?.(tab.deskId);
              }}
                onClose={() => close(tab.id)}
                runStatus={runStatus}
              />
            </div>
          );
        })}
      </div>

      {/* New tab / picker */}
      <button
        type="button"
        onClick={onOpenPicker}
        className="flex w-8 shrink-0 items-center justify-center border-l border-white/10 text-white/40 hover:bg-white/5 hover:text-white"
        title="Open agent picker"
        aria-label="Open agent picker"
      >
        <span className="text-sm font-light">+</span>
      </button>
    </div>
  );
}
