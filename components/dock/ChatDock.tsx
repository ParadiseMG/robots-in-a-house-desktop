"use client";

import { useCallback, useRef, useState } from "react";
import {
  DockTabsContext,
  buildDockTabsValue,
  useDockTabsState,
  useDockTabs,
} from "@/hooks/useDockTabs";
import TabStrip from "@/components/dock/TabStrip";
import ChatTab from "@/components/dock/ChatTab";
import WarRoomTab from "@/components/dock/WarRoomTab";
import NewChatPicker from "@/components/dock/NewChatPicker";
import ReportBugModal from "@/components/errors/ReportBugModal";
import type { OfficeConfig } from "@/lib/office-types";

type RosterEntry = {
  agent: { id: string; deskId: string };
  current: {
    runStatus: string | null;
    acknowledgedAt: number | null;
  } | null;
};

type AgentEntry = {
  id: string;
  name: string;
  role: string;
  deskId: string;
  isReal: boolean;
  officeSlug: string;
};

type Props = {
  agents?: AgentEntry[];
  rosterEntries?: RosterEntry[];
  offices?: Record<string, OfficeConfig>;
  deskRunStatus?: ReadonlyMap<string, string>;
  onAckDesk?: (deskId: string) => void;
  activeOfficeSlug?: string | null;
};

const MIN_HEIGHT = 120;
const DEFAULT_HEIGHT = 280;
const COLLAPSED_HEIGHT = 36;

export function DockTabsProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useDockTabsState();
  const value = buildDockTabsValue(state, dispatch);
  return (
    <DockTabsContext.Provider value={value}>
      {children}
    </DockTabsContext.Provider>
  );
}

export default function ChatDock({ agents = [], rosterEntries = [], offices = {}, deskRunStatus, onAckDesk, activeOfficeSlug }: Props) {
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [collapsed, setCollapsed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [reportBugOpen, setReportBugOpen] = useState(false);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startH: height };
    const onMove = (mv: MouseEvent) => {
      if (!dragRef.current) return;
      const dy = dragRef.current.startY - mv.clientY;
      const maxH = Math.floor(window.innerHeight * 0.85);
      const newH = Math.min(maxH, Math.max(MIN_HEIGHT, dragRef.current.startH + dy));
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

      <TabStrip
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((v) => !v)}
        onOpenPicker={() => setPickerOpen((v) => !v)}
        deskRunStatus={deskRunStatus}
        onAckDesk={onAckDesk}
        onReportBug={() => setReportBugOpen(true)}
      />

      {!collapsed && (
        <div className="flex min-h-0 flex-1 flex-col">
          <InnerDockBody
            pickerOpen={pickerOpen}
            setPickerOpen={setPickerOpen}
            agents={agents}
            rosterEntries={rosterEntries}
            offices={offices}
          />
        </div>
      )}

      <DockBugModal
        open={reportBugOpen}
        onClose={() => setReportBugOpen(false)}
        activeOfficeSlug={activeOfficeSlug}
      />
    </div>
  );
}

function DockBugModal({
  open,
  onClose,
  activeOfficeSlug,
}: {
  open: boolean;
  onClose: () => void;
  activeOfficeSlug?: string | null;
}) {
  const { focusedTab } = useDockTabs();
  return (
    <ReportBugModal
      open={open}
      onClose={onClose}
      officeSlug={activeOfficeSlug}
      agentId={focusedTab?.agentId ?? null}
    />
  );
}

function InnerDockBody({
  pickerOpen,
  setPickerOpen,
  agents,
  rosterEntries,
  offices,
}: {
  pickerOpen: boolean;
  setPickerOpen: (v: boolean) => void;
  agents: AgentEntry[];
  rosterEntries: RosterEntry[];
  offices: Record<string, OfficeConfig>;
}) {
  const { focusedTab, tabs, openWarRoom } = useDockTabs();

  const officeList = Object.values(offices).map((o) => ({
    slug: o.slug,
    name: o.name,
    accent: o.theme.accent,
  }));

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
        <div className="absolute inset-0 z-20 bg-zinc-950">
          <NewChatPicker
            agents={agents}
            onClose={() => setPickerOpen(false)}
            onConveneWarRoom={(slug) => {
              const office = offices[slug];
              openWarRoom(slug, office ? `${office.name} War Room` : "War Room");
            }}
            offices={officeList}
          />
        </div>
      )}

      {/* Active 1:1 tab */}
      {focusedTab && !pickerOpen && focusedTab.kind === "1:1" && focusedTab.agentId && focusedTab.deskId && (
        <ChatTab
          officeSlug={focusedTab.officeSlug}
          agentId={focusedTab.agentId}
          deskId={focusedTab.deskId}
          agentName={focusedTab.label}
        />
      )}

      {/* Active war-room tab */}
      {focusedTab && !pickerOpen && focusedTab.kind === "war-room" && (() => {
        const office = offices[focusedTab.officeSlug];
        if (!office) return null;
        return (
          <WarRoomTab
            key={focusedTab.id}
            tabId={focusedTab.id}
            officeSlug={focusedTab.officeSlug}
            office={office}
            roster={rosterEntries}
          />
        );
      })()}
    </div>
  );
}
