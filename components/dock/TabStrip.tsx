"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useDockTabs, type DockTab } from "@/hooks/useDockTabs";
import Tooltip from "@/components/ui/Tooltip";
import { useVisibleInterval } from "@/hooks/useVisibleInterval";

type AgentEntry = {
  id: string;
  name: string;
  role: string;
  deskId: string;
  isReal: boolean;
  officeSlug: string;
  model?: string | null;
  isHead?: boolean;
  isDeptHead?: boolean;
};

const modelLabel = (m?: string | null) => {
  const s = (m ?? "").toLowerCase();
  if (s.includes("opus")) return "opus";
  if (s.includes("haiku")) return "haiku";
  if (s.includes("sonnet")) return "sonnet";
  return m ?? "sonnet";
};

type AgentStatus = { agentId: string; status: string };
type GroupchatSummary = {
  groupchatId: string;
  status: "running" | "done" | "idle";
  agentStatuses: AgentStatus[];
};

function aggregateStatus(agentStatuses: AgentStatus[]): string {
  if (agentStatuses.some((a) => a.status === "error")) return "error";
  if (agentStatuses.some((a) => a.status === "awaiting_input")) return "awaiting_input";
  if (agentStatuses.some((a) => a.status === "running" || a.status === "starting")) return "running";
  if (agentStatuses.length > 0 && agentStatuses.every((a) => a.status === "done")) return "done";
  return "idle";
}

function useGroupchatStatuses(): ReadonlyMap<string, string> {
  const [statusMap, setStatusMap] = useState<ReadonlyMap<string, string>>(new Map());
  useVisibleInterval(() => {
    fetch("/api/groupchats?status=recent", { cache: "no-store" })
      .then((r) => r.ok ? r.json() as Promise<{ groupchats: GroupchatSummary[] }> : null)
      .then((j) => {
        if (!j) return;
        const m = new Map<string, string>();
        for (const gc of j.groupchats) {
          m.set(gc.groupchatId, gc.status === "idle" ? "idle" : aggregateStatus(gc.agentStatuses));
        }
        setStatusMap(m);
      })
      .catch(() => {});
  }, 3000);
  return statusMap;
}

type Props = {
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenPicker: () => void;
  deskRunStatus?: ReadonlyMap<string, string>;
  onAckDesk?: (deskId: string) => void;
  onReportBug?: () => void;
  agents?: AgentEntry[];
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
    case "delegating":
      return { border: "border-l-purple-500", text: "text-purple-300", dot: "bg-purple-400 animate-pulse" };
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
      data-desk-id={tab.deskId ?? undefined}
      className={`group flex h-full min-w-0 max-w-[160px] items-center gap-1.5 border-l-2 border-r border-r-white/10 px-3 font-mono text-[10px] uppercase tracking-wider transition-colors ${state.border} ${
        focused
          ? `bg-black/60 ${state.text || "text-white"}`
          : `hover:bg-white/5 ${state.text ? state.text + "/80" : "text-white/50 hover:text-white/80"}`
      }`}
      title={tab.label}
    >
      {tab.kind === "groupchat" && (
        <span className="shrink-0 text-[9px] opacity-60">&#9993;</span>
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
          &#10005;
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
  onReportBug,
  agents = [],
}: Props) {
  const { tabs, focusedId, focus, close, reorder, moveToEnd } = useDockTabs();
  const groupchatStatuses = useGroupchatStatuses();
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragOverEnd, setDragOverEnd] = useState<boolean>(false);
  const dragIdRef = useRef<string | null>(null);
  const [hoverTabId, setHoverTabId] = useState<string | null>(null);
  const [hoverPos, setHoverPos] = useState<{ left: number; top: number } | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const agentByDeskId = useCallback(
    (deskId: string | undefined) => agents.find((a) => a.deskId === deskId),
    [agents],
  );

  const showHover = useCallback((tabId: string, el: HTMLElement) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      const rect = el.getBoundingClientRect();
      setHoverTabId(tabId);
      setHoverPos({ left: rect.left + rect.width / 2, top: rect.top });
    }, 350);
  }, []);

  const hideHover = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
    setHoverTabId(null);
    setHoverPos(null);
  }, []);

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
      <Tooltip label={collapsed ? "Expand dock" : "Collapse dock"} position="bottom">
        <button
          type="button"
          onClick={onToggleCollapse}
          className="flex w-8 shrink-0 items-center justify-center border-r border-white/10 text-white/40 hover:bg-white/5 hover:text-white"
          aria-label={collapsed ? "Expand dock" : "Collapse dock"}
        >
          <span className="text-[10px]">{collapsed ? "\u25B2" : "\u25BC"}</span>
        </button>
      </Tooltip>

      {/* Tab list */}
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {tabs.map((tab) => {
          const runStatus =
            tab.kind === "1:1"
              ? (tab.deskId ? deskRunStatus?.get(tab.deskId) : undefined)
              : (tab.groupchatId ? groupchatStatuses.get(tab.groupchatId) : undefined);
          return (
            <div
              key={tab.id}
              className="relative flex h-full items-stretch"
              draggable
              onDragStart={(e) => {
                dragIdRef.current = tab.id;
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", tab.id);
                hideHover();
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dragIdRef.current !== tab.id) {
                  setDragOverId(tab.id);
                  setDragOverEnd(false);
                }
              }}
              onDragLeave={() => {
                setDragOverId(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const fromId = dragIdRef.current;
                if (fromId && fromId !== tab.id) reorder(fromId, tab.id);
                setDragOverId(null);
                dragIdRef.current = null;
              }}
              onDragEnd={() => {
                setDragOverId(null);
                setDragOverEnd(false);
                dragIdRef.current = null;
              }}
              onMouseEnter={(e) => {
                if (tab.kind === "1:1" && tab.deskId) showHover(tab.id, e.currentTarget);
              }}
              onMouseLeave={hideHover}
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
        {/* End drop zone for dragging past last tab */}
        <div
          className="relative flex h-full min-w-8 items-stretch"
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (dragIdRef.current) {
              setDragOverEnd(true);
              setDragOverId(null);
            }
          }}
          onDragLeave={() => {
            setDragOverEnd(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            const fromId = dragIdRef.current;
            if (fromId) {
              moveToEnd(fromId);
            }
            setDragOverEnd(false);
            dragIdRef.current = null;
          }}
        >
          {dragOverEnd && (
            <div className="pointer-events-none absolute inset-y-1 left-0 w-0.5 rounded-full bg-white/60" />
          )}
        </div>
      </div>

      {/* Report bug */}
      {onReportBug && (
        <Tooltip label="Report a bug" position="bottom">
          <button
            type="button"
            onClick={onReportBug}
            className="flex w-8 shrink-0 items-center justify-center border-l border-white/10 text-white/30 hover:bg-red-400/10 hover:text-red-300 transition-colors"
            aria-label="Report a bug"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </button>
        </Tooltip>
      )}

      {/* New tab / picker */}
      <Tooltip label="Open agent picker" position="bottom">
        <button
          type="button"
          onClick={onOpenPicker}
          className="flex w-8 shrink-0 items-center justify-center border-l border-white/10 text-white/40 hover:bg-white/5 hover:text-white"
          aria-label="Open agent picker"
        >
          <span className="text-sm font-light">+</span>
        </button>
      </Tooltip>

      {/* Agent bio hover card */}
      {hoverTabId && hoverPos && (() => {
        const tab = tabs.find((t) => t.id === hoverTabId);
        if (!tab || tab.kind !== "1:1" || !tab.deskId) return null;
        const agent = agentByDeskId(tab.deskId);
        if (!agent) return null;
        const ml = modelLabel(agent.model);
        const isOpus = ml === "opus";
        const status = tab.deskId ? deskRunStatus?.get(tab.deskId) : undefined;
        return (
          <div
            className="fixed z-50 w-48 rounded-md border border-white/15 bg-zinc-900/95 p-2.5 shadow-xl backdrop-blur-sm pointer-events-none"
            style={{ left: hoverPos.left - 96, top: hoverPos.top - 8, transform: "translateY(-100%)" }}
          >
            <div className="mb-1.5 text-sm font-medium text-white">{agent.name}</div>
            <div className="mb-2 text-[11px] leading-snug text-white/50">{agent.role}</div>
            <div className="flex flex-wrap gap-1 font-mono text-[9px] uppercase tracking-wider">
              <span className={agent.isReal ? "rounded bg-emerald-400/20 px-1.5 py-0.5 text-emerald-300" : "rounded bg-white/10 px-1.5 py-0.5 text-white/50"}>
                {agent.isReal ? "real" : "sim"}
              </span>
              {agent.isReal && (
                <span className={isOpus ? "rounded bg-purple-400/20 px-1.5 py-0.5 text-purple-300" : "rounded bg-sky-400/15 px-1.5 py-0.5 text-sky-300"}>
                  {ml}
                </span>
              )}
              {agent.isHead && (
                <span className="rounded bg-amber-400/20 px-1.5 py-0.5 text-amber-300">head</span>
              )}
              {agent.isDeptHead && !agent.isHead && (
                <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-amber-200">dept head</span>
              )}
              {status && status !== "idle" && (
                <span className={`rounded bg-white/5 px-1.5 py-0.5 ${tabStateColor(status).text || "text-white/40"}`}>
                  {status === "done_unacked" ? "done" : status}
                </span>
              )}
            </div>
            <div className="mt-2 font-mono text-[10px] text-white/25">{agent.officeSlug} / {agent.id}</div>
          </div>
        );
      })()}
    </div>
  );
}
