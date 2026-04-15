"use client";

import { useEffect } from "react";
import { useDockTabs, type DockTab } from "@/hooks/useDockTabs";

type Props = {
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenPicker: () => void;
};

const badgeClass = {
  "!": "bg-yellow-400 text-black",
  "✓": "bg-emerald-500 text-black",
} as const;

function TabButton({
  tab,
  focused,
  onFocus,
  onClose,
}: {
  tab: DockTab;
  focused: boolean;
  onFocus: () => void;
  onClose: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onFocus}
      className={`group flex h-full min-w-0 max-w-[160px] items-center gap-1.5 border-r border-white/10 px-3 font-mono text-[10px] uppercase tracking-wider transition-colors ${
        focused
          ? "bg-black/60 text-white"
          : "text-white/50 hover:bg-white/5 hover:text-white/80"
      }`}
      title={tab.label}
    >
      {tab.kind === "war-room" && (
        <span className="shrink-0 text-[9px] opacity-60">⚔</span>
      )}
      <span className="truncate">{tab.label}</span>
      {tab.badge && (
        <span
          className={`shrink-0 rounded px-1 text-[9px] font-bold leading-4 ${badgeClass[tab.badge]}`}
        >
          {tab.badge}
        </span>
      )}
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
}: Props) {
  const { tabs, focusedId, focus, close } = useDockTabs();

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
        {tabs.map((tab) => (
          <TabButton
            key={tab.id}
            tab={tab}
            focused={tab.id === focusedId}
            onFocus={() => focus(tab.id)}
            onClose={() => close(tab.id)}
          />
        ))}
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
