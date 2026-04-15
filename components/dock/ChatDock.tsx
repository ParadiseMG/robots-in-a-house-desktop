"use client";

import { useCallback, useRef, useState } from "react";
import {
  DockTabsContext,
  buildDockTabsValue,
  useDockTabsState,
  useDockTabs,
} from "@/hooks/useDockTabs";
import TabStrip from "@/components/dock/TabStrip";

// Lazy imports — real tab content wired in step 3+
// import ChatTab from "@/components/dock/ChatTab";
// import NewChatPicker from "@/components/dock/NewChatPicker";

type Props = {
  /** All agents across all offices — passed down to NewChatPicker */
  agents?: Array<{
    id: string;
    name: string;
    role: string;
    deskId: string;
    isReal: boolean;
    officeSlug: string;
  }>;
  rosterEntries?: Array<{
    agent: { id: string; deskId: string };
    current: {
      runStatus: string | null;
      acknowledgedAt: number | null;
    } | null;
  }>;
};

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 600;
const DEFAULT_HEIGHT = 280;
const COLLAPSED_HEIGHT = 36; // just the TabStrip

export function DockTabsProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useDockTabsState();
  const value = buildDockTabsValue(state, dispatch);
  return (
    <DockTabsContext.Provider value={value}>
      {children}
    </DockTabsContext.Provider>
  );
}

export default function ChatDock({ agents = [], rosterEntries = [] }: Props) {
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [collapsed, setCollapsed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  // Drag-resize handle
  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startH: height };
    const onMove = (mv: MouseEvent) => {
      if (!dragRef.current) return;
      const dy = dragRef.current.startY - mv.clientY;
      const newH = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, dragRef.current.startH + dy));
      setHeight(newH);
      if (collapsed) setCollapsed(false);
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [height, collapsed]);

  const actualHeight = collapsed ? COLLAPSED_HEIGHT : height;

  return (
    <div
      className="relative flex w-full flex-col border-t border-white/10 bg-zinc-950"
      style={{ height: actualHeight, minHeight: actualHeight, maxHeight: actualHeight }}
    >
      {/* Drag handle */}
      {!collapsed && (
        <div
          onMouseDown={onResizeMouseDown}
          className="absolute -top-1 left-0 right-0 z-10 h-2 cursor-ns-resize opacity-0 hover:opacity-100"
          style={{ background: "rgba(255,255,255,0.15)" }}
        />
      )}

      {/* Tab strip */}
      <TabStrip
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((v) => !v)}
        onOpenPicker={() => setPickerOpen((v) => !v)}
      />

      {/* Body — hidden when collapsed */}
      {!collapsed && (
        <div className="flex min-h-0 flex-1 flex-col">
          <InnerDockBody
            pickerOpen={pickerOpen}
            setPickerOpen={setPickerOpen}
            agents={agents}
            rosterEntries={rosterEntries}
          />
        </div>
      )}
    </div>
  );
}

/** Reads context — separated so it can consume DockTabsContext */
function InnerDockBody({
  pickerOpen,
  setPickerOpen,
  agents,
  rosterEntries,
}: {
  pickerOpen: boolean;
  setPickerOpen: (v: boolean) => void;
  agents: Props["agents"];
  rosterEntries: Props["rosterEntries"];
}) {
  const { focusedTab, tabs } = useDockTabs();

  return (
    <div className="relative flex min-h-0 flex-1">
      {/* Empty state */}
      {tabs.length === 0 && !pickerOpen && (
        <div className="flex flex-1 items-center justify-center font-mono text-xs text-white/30">
          click an agent to open a chat tab · or{" "}
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="ml-1 underline hover:text-white/60"
          >
            pick one
          </button>
        </div>
      )}

      {/* Picker overlay */}
      {pickerOpen && (
        <div className="absolute inset-0 z-20 overflow-y-auto bg-zinc-950 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-wider text-white/50">
              agents
            </span>
            <button
              type="button"
              onClick={() => setPickerOpen(false)}
              className="font-mono text-[10px] text-white/40 hover:text-white"
            >
              ✕
            </button>
          </div>
          <div className="space-y-1">
            {agents?.map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-2 rounded border border-white/10 bg-black/40 px-2 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-white">{a.name}</div>
                  <div className="truncate text-[10px] text-white/50">{a.role}</div>
                </div>
                <span className="font-mono text-[9px] text-white/30">{a.officeSlug}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Active tab content — wired in step 3 */}
      {focusedTab && !pickerOpen && (
        <div className="flex min-h-0 flex-1 flex-col p-3">
          <div className="font-mono text-xs text-white/40">
            {focusedTab.label} — chat coming in step 3
          </div>
        </div>
      )}
    </div>
  );
}
