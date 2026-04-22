"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Tooltip from "@/components/ui/Tooltip";
import { useVisibleInterval } from "@/hooks/useVisibleInterval";

// Front-facing idle frame coordinates in LimeZu premade spritesheets:
// idleS first frame: x = 18 * 16 = 288, y = 32, size = 16x32
// Spritesheet is 896x656.
const FRAME = { x: 288, y: 32, w: 16, h: 32 };
const SHEET = { w: 896, h: 656 };

export type QuickViewAgent = {
  id: string;
  deskId: string;
  name: string;
  role: string;
  officeSlug: string;
  officeName: string;
  accent: string;
  premade: string | null;
  status: string | null;
  activeDelegations: number;
  teamSize: number;
  isHead: boolean;
  isDeptHead?: boolean;
};

type ActivityEntry = { status: string; startedAt: number; endedAt: number | null };
type ActivityMap = Record<string, ActivityEntry[]>;

type GroupchatSummary = {
  groupchatId: string;
  pinnedName: string | null;
  prompt: string;
  status: "running" | "done" | "idle";
  memberCount: number;
  convenedAt: number;
  persistent: boolean;
  agentStatuses: Array<{ agentId: string; officeSlug: string; status: string }>;
};

type Props = {
  heads: QuickViewAgent[];
  pinnedIds: string[];
  hiddenIds: string[];
  allAgents: QuickViewAgent[];
  tabOrder: string[]; // agent IDs in dock tab order
  onChat: (agent: QuickViewAgent) => void;
  onPin: (agentId: string) => void;
  onUnpin: (agentId: string) => void;
  onReorder: (fromId: string, toId: string) => void;
  onSwitchView?: () => void;
  onSettings?: () => void;
  onOpenGroupchat?: (label: string, groupchatId: string) => void;
  onNewGroupchat?: () => void;
};

type StatusFilter = "all" | "busy" | "idle" | "needs_input" | "error" | "done";
type SortMode = "default" | "name" | "activity";
type SizeTier = "full" | "medium" | "small" | "tiny";

const statusLabel = (s: string | null, delegations: number) => {
  if (!s) return { text: "idle", color: "text-white/30", dot: "bg-white/20" };
  if (delegations > 0 && (s === "running" || s === "starting"))
    return { text: "delegating", color: "text-purple-300", dot: "bg-purple-400 animate-pulse" };
  if (s === "running" || s === "starting")
    return { text: "working", color: "text-amber-300", dot: "bg-amber-400 animate-pulse" };
  if (s === "awaiting_input")
    return { text: "needs input", color: "text-yellow-200", dot: "bg-yellow-400 animate-pulse" };
  if (s === "done")
    return { text: "done", color: "text-emerald-300", dot: "bg-emerald-400" };
  if (s === "error")
    return { text: "error", color: "text-red-300", dot: "bg-red-400" };
  return { text: s, color: "text-white/40", dot: "bg-white/20" };
};

function matchesStatusFilter(agent: QuickViewAgent, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  const s = agent.status;
  if (filter === "busy") return s === "running" || s === "starting";
  if (filter === "idle") return !s;
  if (filter === "needs_input") return s === "awaiting_input";
  if (filter === "error") return s === "error";
  if (filter === "done") return s === "done";
  return true;
}

// Size presets
const SIZES = {
  full:   { card: 224, avatar: 96, pad: 24, gap: 12, nameText: 16, subText: 11, monoText: 10, tinyText: 9, dotSize: 12 },
  medium: { card: 180, avatar: 72, pad: 16, gap: 10, nameText: 14, subText: 10, monoText: 9,  tinyText: 8, dotSize: 10 },
  small:  { card: 140, avatar: 56, pad: 12, gap: 8,  nameText: 12, subText: 9,  monoText: 8,  tinyText: 7, dotSize: 8  },
  tiny:   { card: 110, avatar: 44, pad: 8,  gap: 6,  nameText: 11, subText: 8,  monoText: 7,  tinyText: 6, dotSize: 6  },
} as const;

function autoTier(count: number): SizeTier {
  if (count <= 5) return "full";
  if (count <= 8) return "medium";
  if (count <= 12) return "small";
  return "tiny";
}

function spriteStyle(avatar: number, premade: string): {
  wrapper: React.CSSProperties;
  inner: React.CSSProperties;
} {
  const scale = avatar / FRAME.h;
  const charW = FRAME.w * scale;
  return {
    wrapper: {
      width: avatar,
      height: avatar,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    },
    inner: {
      imageRendering: "pixelated" as const,
      backgroundImage: `url(/sprites/characters/${premade})`,
      backgroundRepeat: "no-repeat",
      backgroundSize: `${SHEET.w * scale}px ${SHEET.h * scale}px`,
      backgroundPosition: `-${FRAME.x * scale}px -${FRAME.y * scale}px`,
      width: charW,
      height: avatar,
      flexShrink: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------

function Sparkline({ runs, width = 56, height = 12 }: { runs: ActivityEntry[]; width?: number; height?: number }) {
  if (runs.length === 0) return <div style={{ width, height }} className="opacity-20" />;
  const dotW = Math.max(3, Math.min(6, Math.floor(width / runs.length) - 1));
  const gap = 1;
  const totalW = runs.length * (dotW + gap) - gap;
  const offsetX = Math.max(0, width - totalW);
  return (
    <svg width={width} height={height} className="shrink-0">
      {runs.map((r, i) => {
        const color =
          r.status === "done" ? "#34d399" :
          r.status === "error" ? "#f87171" :
          "#6b7280";
        return (
          <rect
            key={i}
            x={offsetX + i * (dotW + gap)}
            y={Math.round((height - dotW) / 2)}
            width={dotW}
            height={dotW}
            rx={1}
            fill={color}
            opacity={0.8}
          />
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Quick-cast input
// ---------------------------------------------------------------------------

function QuickCast({
  agentName,
  officeSlug,
  agentId,
  onSent,
  onClose,
  fontSize,
}: {
  agentName: string;
  officeSlug: string;
  agentId: string;
  onSent: () => void;
  onClose: () => void;
  fontSize: number;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await fetch("/api/quick-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ officeSlug, agentId, prompt: trimmed }),
      });
      setText("");
      onSent();
    } catch {
      // ignore
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="absolute inset-x-0 bottom-0 z-20 rounded-b-xl border-t border-white/10 bg-black/80 px-2 py-1.5 backdrop-blur-sm"
      onClick={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void send();
          if (e.key === "Escape") onClose();
        }}
        placeholder={`ask ${agentName}...`}
        disabled={sending}
        className="w-full bg-transparent font-mono text-white placeholder:text-white/25 outline-none disabled:opacity-50"
        style={{ fontSize }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent Card
// ---------------------------------------------------------------------------

function AgentCard({
  agent,
  onChat,
  onRemove,
  onPin,
  isPinned,
  isAutoVisible,
  tier,
  sparkline,
  selected,
  onSelect,
  selectMode,
  flashing,
  expanded,
  onToggleExpand,
  lastMessage,
}: {
  agent: QuickViewAgent;
  onChat: () => void;
  onRemove?: () => void;
  onPin?: () => void;
  isPinned: boolean;
  isAutoVisible: boolean;
  tier: SizeTier;
  sparkline: ActivityEntry[];
  selected?: boolean;
  onSelect?: () => void;
  selectMode?: boolean;
  flashing?: "done" | "error" | "awaiting_input" | null;
  expanded?: boolean;
  onToggleExpand?: () => void;
  lastMessage?: string | null;
}) {
  const sz = SIZES[tier];
  const st = statusLabel(agent.status, agent.activeDelegations);
  const [showCast, setShowCast] = useState(false);

  const flashBorder =
    flashing === "done" ? "border-emerald-400/60 shadow-[0_0_12px_2px_rgba(52,211,153,0.3)]" :
    flashing === "error" ? "border-red-400/60 shadow-[0_0_12px_2px_rgba(248,113,113,0.3)]" :
    flashing === "awaiting_input" ? "border-yellow-400/60 shadow-[0_0_12px_2px_rgba(250,204,21,0.3)]" :
    "";

  return (
    <div
      data-desk-id={agent.deskId}
      data-agent-id={agent.id}
      className={`group relative flex flex-col items-center rounded-xl border bg-zinc-900/80 shadow-lg backdrop-blur-sm transition-all hover:border-white/25 hover:bg-zinc-800/80 hover:shadow-xl cursor-pointer ${
        selected ? "ring-2 ring-indigo-400/60 border-indigo-400/40" : flashBorder || "border-white/10"
      }`}
      style={{
        width: expanded ? Math.max(sz.card, 280) : sz.card,
        padding: sz.pad,
        paddingBottom: showCast ? sz.pad + 28 : sz.pad,
        gap: sz.gap,
        borderTopColor: selected ? "#818cf8" : agent.accent + "88",
        borderTopWidth: 2,
      }}
      onClick={(e) => {
        if (showCast) return;
        if (selectMode) {
          e.preventDefault();
          onSelect?.();
        } else if (e.shiftKey) {
          e.preventDefault();
          setShowCast(true);
        } else {
          onChat();
        }
      }}
    >
      {/* Top-right: expand + remove + pin */}
      <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition">
        {onToggleExpand && (
          <Tooltip label={expanded ? "Collapse" : "Expand preview"}>
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpand();
              }}
              className="rounded px-1 py-0.5 font-mono text-white/20 hover:text-white/60"
              style={{ fontSize: sz.monoText }}
            >
              {expanded ? "−" : "+"}
            </span>
          </Tooltip>
        )}
        {onPin && !isAutoVisible && (
          <Tooltip label={isPinned ? "Unpin" : "Pin to view"}>
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                onPin();
              }}
              className={`rounded px-1 py-0.5 font-mono transition ${isPinned ? "text-amber-400/70 hover:text-amber-300" : "text-white/20 hover:text-white/60"}`}
              style={{ fontSize: sz.monoText }}
            >
              {isPinned ? "pinned" : "pin"}
            </span>
          </Tooltip>
        )}
        {onRemove && (
          <Tooltip label="Remove from view">
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              className="rounded px-1 py-0.5 font-mono text-white/20 hover:text-white/60"
              style={{ fontSize: sz.monoText }}
            >
              x
            </span>
          </Tooltip>
        )}
      </div>

      {/* Sprite */}
      <div
        className="relative overflow-hidden rounded-full border-2 border-white/10 bg-black/40"
        style={{ width: sz.avatar, height: sz.avatar }}
      >
        {agent.premade ? (() => {
          const s = spriteStyle(sz.avatar, agent.premade);
          return <div style={s.wrapper}><div style={s.inner} /></div>;
        })() : (
          <div className="flex h-full w-full items-center justify-center text-white/20" style={{ fontSize: sz.nameText }}>
            ?
          </div>
        )}
        {/* Status dot */}
        <div
          className={`absolute rounded-full border border-zinc-900 ${st.dot}`}
          style={{ width: sz.dotSize, height: sz.dotSize, bottom: 2, right: 2 }}
        />
      </div>

      {/* Name + role */}
      <div className="w-full text-center">
        <div className="truncate font-medium text-white" style={{ fontSize: sz.nameText }}>{agent.name}</div>
        <div className="truncate text-white/40" style={{ fontSize: sz.subText, marginTop: 2 }}>{agent.role}</div>
      </div>

      {/* Status + sparkline */}
      <div className="flex w-full items-center justify-between">
        <div className="flex items-center gap-1 font-mono uppercase tracking-wider" style={{ fontSize: sz.monoText }}>
          <span className={st.color}>{st.text}</span>
          {agent.activeDelegations > 0 && (
            <span className="text-purple-300/60">({agent.activeDelegations})</span>
          )}
        </div>
        {sparkline.length > 0 && (
          <Tooltip label={`${sparkline.filter(r => r.status === "done").length} done / ${sparkline.filter(r => r.status === "error").length} error recently`}>
            <span><Sparkline runs={sparkline} width={tier === "tiny" ? 36 : tier === "small" ? 44 : 56} height={tier === "tiny" ? 8 : 12} /></span>
          </Tooltip>
        )}
      </div>

      {/* Bottom line: team size for heads, office for others */}
      <div className="truncate font-mono uppercase tracking-wider text-white/25" style={{ fontSize: sz.tinyText }}>
        {agent.isHead
          ? `${agent.teamSize} agent${agent.teamSize !== 1 ? "s" : ""}`
          : agent.officeName}
      </div>

      {/* Expanded preview */}
      {expanded && (
        <div
          className="w-full rounded-lg border border-white/5 bg-black/40 px-3 py-2"
          onClick={(e) => e.stopPropagation()}
        >
          {lastMessage === undefined ? (
            <div className="font-mono text-white/20 animate-pulse" style={{ fontSize: sz.tinyText }}>loading...</div>
          ) : lastMessage ? (
            <div className="line-clamp-4 font-mono text-white/50 leading-relaxed" style={{ fontSize: sz.tinyText }}>
              {lastMessage}
            </div>
          ) : (
            <div className="font-mono text-white/15" style={{ fontSize: sz.tinyText }}>no messages yet</div>
          )}
        </div>
      )}

      {/* Quick-cast overlay */}
      {showCast && (
        <QuickCast
          agentName={agent.name}
          officeSlug={agent.officeSlug}
          agentId={agent.id}
          fontSize={sz.monoText}
          onSent={() => setShowCast(false)}
          onClose={() => setShowCast(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Groupchat Card
// ---------------------------------------------------------------------------

const gcStatusStyle = (s: string) => {
  if (s === "running") return { text: "active", color: "text-sky-300", dot: "bg-sky-400 animate-pulse" };
  if (s === "done") return { text: "done", color: "text-emerald-300", dot: "bg-emerald-400" };
  return { text: "idle", color: "text-white/30", dot: "bg-white/20" };
};

function GroupchatCard({
  gc,
  agentNames,
  onClick,
  tier,
}: {
  gc: GroupchatSummary;
  agentNames: Map<string, string>;
  onClick: () => void;
  tier: SizeTier;
}) {
  const sz = SIZES[tier];
  const st = gcStatusStyle(gc.status);
  const label = gc.pinnedName || gc.prompt;
  const members = gc.agentStatuses
    .map((a) => agentNames.get(a.agentId) ?? a.agentId)
    .slice(0, 4);
  const extra = gc.agentStatuses.length - members.length;

  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative flex flex-col items-center rounded-xl border border-white/10 bg-zinc-900/80 shadow-lg backdrop-blur-sm transition-all hover:border-white/25 hover:bg-zinc-800/80 hover:shadow-xl cursor-pointer"
      style={{
        width: sz.card,
        padding: sz.pad,
        gap: sz.gap,
        borderTopColor: "#6366f1" + "88",
        borderTopWidth: 2,
      }}
    >
      {/* Icon */}
      <div
        className="flex items-center justify-center rounded-full border-2 border-indigo-400/20 bg-indigo-500/10"
        style={{ width: sz.avatar * 0.7, height: sz.avatar * 0.7 }}
      >
        <svg
          width={sz.avatar * 0.3}
          height={sz.avatar * 0.3}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="text-indigo-300"
        >
          <path d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      {/* Title */}
      <div className="w-full text-center">
        <div className="line-clamp-2 font-medium text-white" style={{ fontSize: sz.nameText * 0.85 }}>
          {label}
        </div>
      </div>

      {/* Members */}
      <div className="truncate text-center text-white/35" style={{ fontSize: sz.tinyText }}>
        {members.join(", ")}{extra > 0 ? ` +${extra}` : ""}
      </div>

      {/* Status */}
      <div className="flex items-center gap-1.5 font-mono uppercase tracking-wider" style={{ fontSize: sz.monoText }}>
        <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} />
        <span className={st.color}>{st.text}</span>
        {gc.persistent && (
          <span className="text-white/20">pinned</span>
        )}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Add Agent Picker (modal)
// ---------------------------------------------------------------------------

function AddAgentPicker({
  agents,
  onPick,
  onClose,
}: {
  agents: QuickViewAgent[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = agents.filter(
    (a) =>
      a.name.toLowerCase().includes(search.toLowerCase()) ||
      a.role.toLowerCase().includes(search.toLowerCase()) ||
      a.officeName.toLowerCase().includes(search.toLowerCase()),
  );

  const grouped = filtered.reduce<Record<string, QuickViewAgent[]>>((acc, a) => {
    acc[a.officeSlug] = acc[a.officeSlug] ?? [];
    acc[a.officeSlug].push(a);
    return acc;
  }, {});

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-80 max-h-[70vh] overflow-hidden rounded-xl border border-white/15 bg-zinc-900/95 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <span className="font-mono text-[11px] uppercase tracking-wider text-white/50">
            add to view
          </span>
          <button type="button" onClick={onClose} className="text-white/30 hover:text-white text-sm">x</button>
        </div>
        <div className="border-b border-white/10 px-4 py-2">
          <input
            type="text"
            placeholder="Search agents..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-transparent font-mono text-sm text-white placeholder:text-white/25 outline-none"
            autoFocus
          />
        </div>
        <div className="overflow-y-auto p-2 max-h-[50vh] space-y-3">
          {Object.entries(grouped).map(([slug, groupAgents]) => (
            <div key={slug}>
              <div className="mb-1 px-2 font-mono text-[9px] uppercase tracking-wider text-white/30">
                {groupAgents[0].officeName}
              </div>
              <div className="space-y-0.5">
                {groupAgents.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => { onPick(agent.id); onClose(); }}
                    className="flex w-full items-center gap-3 rounded-lg border border-white/5 px-3 py-2 text-left transition hover:border-white/15 hover:bg-white/5"
                  >
                    <div className="relative h-8 w-8 shrink-0 overflow-hidden rounded-full border border-white/10 bg-black/40">
                      {agent.premade ? (() => {
                        const s = spriteStyle(32, agent.premade);
                        return <div style={s.wrapper}><div style={s.inner} /></div>;
                      })() : (
                        <div className="flex h-full w-full items-center justify-center text-[10px] text-white/20">?</div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-white">{agent.name}</div>
                      <div className="truncate text-[10px] text-white/40">{agent.role}</div>
                    </div>
                    {agent.isHead && (
                      <span className="rounded bg-amber-400/20 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-amber-300">head</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="py-4 text-center font-mono text-[11px] text-white/25">no matches</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter / Sort Toolbar
// ---------------------------------------------------------------------------

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "all" },
  { key: "busy", label: "busy" },
  { key: "idle", label: "idle" },
  { key: "needs_input", label: "input" },
  { key: "done", label: "done" },
  { key: "error", label: "error" },
];

const SORT_MODES: { key: SortMode; label: string }[] = [
  { key: "default", label: "default" },
  { key: "name", label: "a-z" },
  { key: "activity", label: "activity" },
];

const SIZE_TIERS: { key: SizeTier | "auto"; label: string }[] = [
  { key: "auto", label: "auto" },
  { key: "full", label: "lg" },
  { key: "medium", label: "md" },
  { key: "small", label: "sm" },
  { key: "tiny", label: "xs" },
];

function Toolbar({
  officeFilter,
  setOfficeFilter,
  statusFilter,
  setStatusFilter,
  sortMode,
  setSortMode,
  sizeTier,
  setSizeTier,
  offices,
  counts,
}: {
  officeFilter: string;
  setOfficeFilter: (v: string) => void;
  statusFilter: StatusFilter;
  setStatusFilter: (v: StatusFilter) => void;
  sortMode: SortMode;
  setSortMode: (v: SortMode) => void;
  sizeTier: SizeTier | "auto";
  setSizeTier: (v: SizeTier | "auto") => void;
  offices: { slug: string; name: string; accent: string }[];
  counts: { total: number; busy: number; idle: number; needs_input: number; done: number; error: number };
}) {
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-lg border border-white/8 bg-zinc-900/60 px-4 py-2 backdrop-blur-sm">
      {/* Office filter */}
      <div className="flex items-center gap-1">
        <span className="mr-1 font-mono text-[9px] uppercase tracking-wider text-white/25">office</span>
        <button
          onClick={() => setOfficeFilter("all")}
          className={`rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition ${
            officeFilter === "all" ? "bg-white/10 text-white" : "text-white/35 hover:text-white/60"
          }`}
        >
          all
        </button>
        {offices.map((o) => (
          <button
            key={o.slug}
            onClick={() => setOfficeFilter(o.slug)}
            className="rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition"
            style={
              officeFilter === o.slug
                ? { backgroundColor: o.accent + "22", color: o.accent }
                : { color: "rgba(255,255,255,0.35)" }
            }
          >
            {o.name}
          </button>
        ))}
      </div>

      {/* Divider */}
      <div className="h-4 w-px bg-white/10" />

      {/* Status filter */}
      <div className="flex items-center gap-1">
        <span className="mr-1 font-mono text-[9px] uppercase tracking-wider text-white/25">status</span>
        {STATUS_FILTERS.map((f) => {
          const count = f.key === "all" ? counts.total : counts[f.key as keyof typeof counts] ?? 0;
          if (f.key !== "all" && count === 0) return null;
          return (
            <button
              key={f.key}
              onClick={() => setStatusFilter(f.key)}
              className={`rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition ${
                statusFilter === f.key ? "bg-white/10 text-white" : "text-white/35 hover:text-white/60"
              }`}
            >
              {f.label}
              {f.key !== "all" && <span className="ml-1 text-white/20">{count}</span>}
            </button>
          );
        })}
      </div>

      {/* Divider */}
      <div className="h-4 w-px bg-white/10" />

      {/* Sort */}
      <div className="flex items-center gap-1">
        <span className="mr-1 font-mono text-[9px] uppercase tracking-wider text-white/25">sort</span>
        {SORT_MODES.map((m) => (
          <button
            key={m.key}
            onClick={() => setSortMode(m.key)}
            className={`rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition ${
              sortMode === m.key ? "bg-white/10 text-white" : "text-white/35 hover:text-white/60"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Divider */}
      <div className="h-4 w-px bg-white/10" />

      {/* Size */}
      <div className="flex items-center gap-1">
        <span className="mr-1 font-mono text-[9px] uppercase tracking-wider text-white/25">size</span>
        {SIZE_TIERS.map((s) => (
          <button
            key={s.key}
            onClick={() => setSizeTier(s.key)}
            className={`rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition ${
              sizeTier === s.key ? "bg-white/10 text-white" : "text-white/35 hover:text-white/60"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function HeadsView({ heads, pinnedIds, hiddenIds, allAgents, tabOrder, onChat, onPin, onUnpin, onReorder, onSwitchView, onSettings, onOpenGroupchat, onNewGroupchat }: Props) {
  const [showPicker, setShowPicker] = useState(false);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Multi-select mode for batch groupchat — press G to enter, Escape to exit
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, []);

  // Status flash — track previous statuses, persist until card is clicked
  const prevStatusRef = useRef<Map<string, string | null>>(new Map());
  const [flashingIds, setFlashingIds] = useState<Map<string, "done" | "error" | "awaiting_input">>(new Map());
  useEffect(() => {
    const prev = prevStatusRef.current;
    let changed = false;
    const next = new Map(flashingIds);
    for (const a of allAgents) {
      const old = prev.get(a.id);
      if (old !== undefined && old !== a.status) {
        if (a.status === "done") { next.set(a.id, "done"); changed = true; }
        else if (a.status === "error") { next.set(a.id, "error"); changed = true; }
        else if (a.status === "awaiting_input") { next.set(a.id, "awaiting_input"); changed = true; }
        // If agent starts working again, clear its flash
        else if (a.status === "running" || a.status === "starting") {
          if (next.has(a.id)) { next.delete(a.id); changed = true; }
        }
      }
      prev.set(a.id, a.status);
    }
    if (changed) setFlashingIds(next);
  }, [allAgents]); // eslint-disable-line react-hooks/exhaustive-deps
  const dismissFlash = useCallback((id: string) => {
    setFlashingIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Expand-in-place — track expanded cards and their last messages
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [lastMessages, setLastMessages] = useState<Record<string, string | null>>({});
  const toggleExpand = useCallback((agentId: string, officeSlug: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) {
        next.delete(agentId);
      } else {
        next.add(agentId);
        // Fetch last message if we don't have it
        if (!(agentId in lastMessages)) {
          fetch(`/api/session/transcript?office=${encodeURIComponent(officeSlug)}&agentId=${encodeURIComponent(agentId)}`, { cache: "no-store" })
            .then((r) => r.ok ? r.json() as Promise<{ messages: Array<{ role: string; text: string }> }> : null)
            .then((j) => {
              if (!j) { setLastMessages((p) => ({ ...p, [agentId]: null })); return; }
              const last = [...j.messages].reverse().find((m) => m.role === "assistant");
              setLastMessages((p) => ({ ...p, [agentId]: last?.text?.slice(0, 200) ?? null }));
            })
            .catch(() => setLastMessages((p) => ({ ...p, [agentId]: null })));
        }
      }
      return next;
    });
  }, [lastMessages]);

  // Section order (persisted)
  const [sectionOrder, setSectionOrder] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try { return JSON.parse(localStorage.getItem("ri-grid-section-order") ?? "[]") as string[]; }
    catch { return []; }
  });
  useEffect(() => { localStorage.setItem("ri-grid-section-order", JSON.stringify(sectionOrder)); }, [sectionOrder]);
  const [dragSectionSlug, setDragSectionSlug] = useState<string | null>(null);
  const [dragSectionOver, setDragSectionOver] = useState<string | null>(null);

  // Search (for / shortcut)
  const [searchText, setSearchText] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);

  // Keyboard navigation
  const [focusIndex, setFocusIndex] = useState(-1);

  // Toolbar state (persisted to localStorage)
  const [officeFilter, setOfficeFilter] = useState<string>(() => {
    if (typeof window === "undefined") return "all";
    return localStorage.getItem("ri-grid-office") ?? "all";
  });
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>(() => {
    if (typeof window === "undefined") return "default";
    return (localStorage.getItem("ri-grid-sort") as SortMode) ?? "default";
  });
  const [sizeTier, setSizeTier] = useState<SizeTier | "auto">(() => {
    if (typeof window === "undefined") return "auto";
    return (localStorage.getItem("ri-grid-size") as SizeTier | "auto") ?? "auto";
  });

  // Persist toolbar prefs
  useEffect(() => { localStorage.setItem("ri-grid-office", officeFilter); }, [officeFilter]);
  useEffect(() => { localStorage.setItem("ri-grid-sort", sortMode); }, [sortMode]);
  useEffect(() => { localStorage.setItem("ri-grid-size", sizeTier); }, [sizeTier]);

  // Activity data for sparklines
  const [activity, setActivity] = useState<ActivityMap>({});
  const officeSlugs = useMemo(() => {
    const s = new Set(allAgents.map((a) => a.officeSlug));
    return [...s];
  }, [allAgents]);

  useVisibleInterval(() => {
    if (officeSlugs.length === 0) return;
    fetch(`/api/activity?offices=${officeSlugs.join(",")}`, { cache: "no-store" })
      .then((r) => r.ok ? r.json() as Promise<{ activity: ActivityMap }> : null)
      .then((j) => { if (j) setActivity(j.activity); })
      .catch(() => {});
  }, 15_000, [officeSlugs]);

  // Groupchats
  const [groupchats, setGroupchats] = useState<GroupchatSummary[]>([]);
  useVisibleInterval(() => {
    fetch("/api/groupchats?status=recent", { cache: "no-store" })
      .then((r) => r.ok ? r.json() as Promise<{ groupchats: GroupchatSummary[] }> : null)
      .then((j) => { if (j) setGroupchats(j.groupchats); })
      .catch(() => {});
  }, 5_000);

  // Agent name lookup for groupchat member names
  const agentNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of allAgents) m.set(a.id, a.name);
    return m;
  }, [allAgents]);

  const hiddenSet = new Set(hiddenIds);

  // Auto-visible: heads, dept heads, and all ops center agents (unless hidden)
  const autoVisibleIds = useMemo(() => {
    const ids = new Set<string>();
    for (const a of allAgents) {
      if (hiddenSet.has(a.id)) continue;
      // Heads and dept heads from any office
      if (a.isHead || a.isDeptHead) ids.add(a.id);
      // All agents from the ops office (slug contains "operations" or name contains "ops")
      if (a.officeName.toLowerCase().includes("ops") || a.officeSlug.includes("operations")) {
        ids.add(a.id);
      }
    }
    return ids;
  }, [allAgents, hiddenIds]);

  const allVisible = useMemo(() => {
    const seen = new Set<string>();
    const result: QuickViewAgent[] = [];
    // Auto-visible agents first
    for (const a of allAgents) {
      if (autoVisibleIds.has(a.id) && !seen.has(a.id)) {
        seen.add(a.id);
        result.push(a);
      }
    }
    // Then pinned agents
    for (const id of pinnedIds) {
      if (seen.has(id) || hiddenSet.has(id)) continue;
      const a = allAgents.find((ag) => ag.id === id);
      if (a) { seen.add(id); result.push(a); }
    }
    return result;
  }, [allAgents, autoVisibleIds, pinnedIds, hiddenIds]);

  // Sort
  const sorted = useMemo(() => {
    let list = [...allVisible];
    if (sortMode === "name") {
      list.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortMode === "activity") {
      // Most recent activity first
      list.sort((a, b) => {
        const aRuns = activity[a.id] ?? [];
        const bRuns = activity[b.id] ?? [];
        const aLast = aRuns.length > 0 ? aRuns[aRuns.length - 1].startedAt : 0;
        const bLast = bRuns.length > 0 ? bRuns[bRuns.length - 1].startedAt : 0;
        return bLast - aLast;
      });
    } else {
      // Default: match dock tab order
      if (tabOrder.length > 0) {
        const tabMap = new Map(tabOrder.map((id, i) => [id, i]));
        list.sort((a, b) => {
          const ai = tabMap.has(a.id) ? tabMap.get(a.id)! : tabOrder.length + allVisible.indexOf(a);
          const bi = tabMap.has(b.id) ? tabMap.get(b.id)! : tabOrder.length + allVisible.indexOf(b);
          return ai - bi;
        });
      }
    }
    return list;
  }, [allVisible, sortMode, tabOrder, activity]);

  // Apply filters + search
  const filtered = useMemo(() => {
    let list = sorted.filter((a) => {
      if (officeFilter !== "all" && a.officeSlug !== officeFilter) return false;
      if (!matchesStatusFilter(a, statusFilter)) return false;
      return true;
    });
    if (searchText.trim()) {
      const q = searchText.toLowerCase();
      list = list.filter((a) =>
        a.name.toLowerCase().includes(q) ||
        a.role.toLowerCase().includes(q) ||
        a.officeName.toLowerCase().includes(q),
      );
    }
    return list;
  }, [sorted, officeFilter, statusFilter, searchText]);

  // Keyboard shortcuts (after filtered is available)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const inInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

      if (e.key === "Escape") {
        if (selectMode) { exitSelectMode(); e.preventDefault(); return; }
        if (searchFocused) { setSearchText(""); searchRef.current?.blur(); setSearchFocused(false); e.preventDefault(); return; }
        if (expandedIds.size > 0) { setExpandedIds(new Set()); e.preventDefault(); return; }
        setFocusIndex(-1);
        return;
      }

      if (inInput) return;

      // G = toggle groupchat select mode
      if ((e.key === "g" || e.key === "G") && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (selectMode) {
          exitSelectMode();
        } else {
          setSelectMode(true);
          setSelectedIds(new Set());
        }
        return;
      }

      if (e.key === "/" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === "n" || e.key === "N") {
        if (!e.metaKey && !e.ctrlKey && onNewGroupchat) {
          e.preventDefault();
          onNewGroupchat();
          return;
        }
      }
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        setFocusIndex((i) => Math.min(i + 1, (filtered?.length ?? 1) - 1));
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        setFocusIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" && focusIndex >= 0) {
        if (selectMode) {
          const agent = filtered?.[focusIndex];
          if (agent) toggleSelect(agent.id);
        } else {
          const agent = filtered?.[focusIndex];
          if (agent) onChat(agent);
        }
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectMode, selectedIds, searchFocused, expandedIds, focusIndex, filtered, onChat, onNewGroupchat, exitSelectMode, toggleSelect]);

  // Scroll focused card into view
  useEffect(() => {
    if (focusIndex < 0) return;
    const cards = containerRef.current?.querySelectorAll("[data-agent-id]");
    if (cards?.[focusIndex]) {
      (cards[focusIndex] as HTMLElement).scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [focusIndex]);

  // Group into smart sections: Directors first, then by office
  const grouped = useMemo(() => {
    const groups: { slug: string; name: string; accent: string; agents: QuickViewAgent[] }[] = [];

    // Pull directors (heads) into their own section when showing all offices
    const directors = filtered.filter((a) => a.isHead);
    const rest = filtered.filter((a) => !a.isHead);

    if (directors.length > 0 && officeFilter === "all") {
      groups.push({
        slug: "_directors",
        name: "Directors",
        accent: "#a78bfa",
        agents: directors,
      });
    }

    // Group remaining agents by office
    const seen = new Set<string>();
    const agentsToGroup = officeFilter === "all" ? rest : filtered;
    for (const a of agentsToGroup) {
      if (!seen.has(a.officeSlug)) {
        seen.add(a.officeSlug);
        groups.push({ slug: a.officeSlug, name: a.officeName, accent: a.accent, agents: [] });
      }
      groups.find((g) => g.slug === a.officeSlug)!.agents.push(a);
    }

    // Remove empty groups, then apply saved section order
    const nonEmpty = groups.filter((g) => g.agents.length > 0);
    if (sectionOrder.length > 0) {
      const orderMap = new Map(sectionOrder.map((s, i) => [s, i]));
      nonEmpty.sort((a, b) => {
        const ai = orderMap.get(a.slug) ?? 999;
        const bi = orderMap.get(b.slug) ?? 999;
        return ai - bi;
      });
    }
    return nonEmpty;
  }, [filtered, officeFilter, sectionOrder]);

  // Status counts for toolbar badges
  const counts = useMemo(() => {
    const c = { total: allVisible.length, busy: 0, idle: 0, needs_input: 0, done: 0, error: 0 };
    for (const a of allVisible) {
      const s = a.status;
      if (!s) c.idle++;
      else if (s === "running" || s === "starting") c.busy++;
      else if (s === "awaiting_input") c.needs_input++;
      else if (s === "done") c.done++;
      else if (s === "error") c.error++;
    }
    return c;
  }, [allVisible]);

  // Unique offices for filter buttons
  const offices = useMemo(() => {
    const seen = new Map<string, { slug: string; name: string; accent: string }>();
    for (const a of allAgents) {
      if (!seen.has(a.officeSlug)) {
        seen.set(a.officeSlug, { slug: a.officeSlug, name: a.officeName, accent: a.accent });
      }
    }
    return [...seen.values()];
  }, [allAgents]);

  // Available to pin (agents not currently visible)
  const visibleIds = new Set(allVisible.map((a) => a.id));
  const available = allAgents.filter((a) => !visibleIds.has(a.id));
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);

  // Compute tier
  const effectiveTier: SizeTier = sizeTier === "auto" ? autoTier(filtered.length + 1) : sizeTier;
  const sz = SIZES[effectiveTier];
  const containerGap = effectiveTier === "full" ? 24 : effectiveTier === "medium" ? 18 : effectiveTier === "small" ? 14 : 10;

  const handleDrop = useCallback((targetId: string) => {
    const fromId = dragIdRef.current;
    if (!fromId || fromId === targetId) return;
    onReorder(fromId, targetId);
  }, [onReorder]);

  const renderCard = (agent: QuickViewAgent, idx?: number) => (
    <div
      key={agent.id}
      draggable
      onDragStart={(e) => {
        dragIdRef.current = agent.id;
        setDraggingId(agent.id);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", agent.id);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (dragIdRef.current !== agent.id) setDragOverId(agent.id);
      }}
      onDragLeave={() => setDragOverId(null)}
      onDrop={(e) => {
        e.preventDefault();
        handleDrop(agent.id);
        setDragOverId(null);
        setDraggingId(null);
        dragIdRef.current = null;
      }}
      onDragEnd={() => {
        setDragOverId(null);
        setDraggingId(null);
        dragIdRef.current = null;
      }}
      className={`relative transition-opacity ${draggingId === agent.id ? "opacity-40" : ""} ${idx !== undefined && idx === focusIndex ? "ring-1 ring-sky-400/50 rounded-xl" : ""}`}
    >
      {dragOverId === agent.id && (
        <div className="pointer-events-none absolute -left-[6px] inset-y-0 z-10 flex items-center">
          <div className="h-full w-[3px] rounded-full bg-sky-400 shadow-[0_0_8px_2px_rgba(56,189,248,0.5)]" />
        </div>
      )}
      <AgentCard
        agent={agent}
        tier={effectiveTier}
        onChat={() => { dismissFlash(agent.id); onChat(agent); }}
        onRemove={() => onUnpin(agent.id)}
        onPin={() => pinnedSet.has(agent.id) ? onUnpin(agent.id) : onPin(agent.id)}
        isPinned={pinnedSet.has(agent.id)}
        isAutoVisible={autoVisibleIds.has(agent.id)}
        sparkline={activity[agent.id] ?? []}
        selected={selectedIds.has(agent.id)}
        selectMode={selectMode}
        onSelect={() => toggleSelect(agent.id)}
        flashing={flashingIds.get(agent.id) ?? null}
        expanded={expandedIds.has(agent.id)}
        onToggleExpand={() => toggleExpand(agent.id, agent.officeSlug)}
        lastMessage={expandedIds.has(agent.id) ? lastMessages[agent.id] : undefined}
      />
    </div>
  );

  const showGroupHeaders = officeFilter === "all" && grouped.length > 1;

  // Track flat index for renderCard in grouped mode
  let flatIdx = 0;
  const nextIdx = () => flatIdx++;

  return (
    <div ref={containerRef} className={`flex min-w-0 flex-1 flex-col overflow-hidden ${selectMode ? "cursor-crosshair" : ""}`}>
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-3 px-4 pt-3 pb-2">
        {/* View/settings buttons */}
        <div className="flex shrink-0 gap-1.5">
          {onSettings && (
            <Tooltip label="Settings" position="bottom">
              <button
                type="button"
                onClick={onSettings}
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-800/80 text-gray-400 transition-colors hover:bg-zinc-700 hover:text-white"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" shapeRendering="crispEdges">
                  <rect x="6" y="0" width="4" height="2" fill="currentColor" />
                  <rect x="6" y="14" width="4" height="2" fill="currentColor" />
                  <rect x="0" y="6" width="2" height="4" fill="currentColor" />
                  <rect x="14" y="6" width="2" height="4" fill="currentColor" />
                  <rect x="3" y="3" width="10" height="10" fill="currentColor" />
                  <rect x="5" y="5" width="6" height="6" fill="#1a1a2e" />
                </svg>
              </button>
            </Tooltip>
          )}
          {onSwitchView && (
            <Tooltip label="Switch to canvas view" position="bottom">
              <button
                type="button"
                onClick={onSwitchView}
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-800/80 text-gray-400 transition-colors hover:bg-zinc-700 hover:text-white"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="2" width="12" height="12" rx="1" />
                  <circle cx="8" cy="8" r="2" />
                  <path d="M2 8h4M10 8h4M8 2v4M8 10v4" />
                </svg>
              </button>
            </Tooltip>
          )}
        </div>
        {/* Search */}
        <div className="relative">
          <input
            ref={searchRef}
            type="text"
            value={searchText}
            onChange={(e) => { setSearchText(e.target.value); setFocusIndex(-1); }}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            placeholder="/ search..."
            className="w-36 rounded-lg border border-white/10 bg-zinc-900/60 px-2.5 py-1.5 font-mono text-[11px] text-white placeholder:text-white/20 outline-none focus:border-white/25 focus:w-52 transition-all"
          />
          {searchText && (
            <button
              type="button"
              onClick={() => { setSearchText(""); searchRef.current?.focus(); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-white/25 hover:text-white/60 text-xs"
            >
              x
            </button>
          )}
        </div>
        <Toolbar
          officeFilter={officeFilter}
          setOfficeFilter={setOfficeFilter}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          sortMode={sortMode}
          setSortMode={setSortMode}
          sizeTier={sizeTier}
          setSizeTier={setSizeTier}
          offices={offices}
          counts={counts}
        />
      </div>

      {/* Cards area */}
      <div className="flex-1 overflow-auto px-6 py-4">
        {filtered.length === 0 && (
          <div className="flex h-full items-center justify-center font-mono text-xs text-white/25">
            no agents match filters
          </div>
        )}

        {showGroupHeaders ? (
          // Grouped by office
          <div className="space-y-6">
            {(() => { flatIdx = 0; return null; })()}
            {grouped.map((group) => (
              <div
                key={group.slug}
                onDragOver={(e) => {
                  if (!dragSectionSlug || dragSectionSlug === group.slug) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setDragSectionOver(group.slug);
                }}
                onDragLeave={() => { if (dragSectionOver === group.slug) setDragSectionOver(null); }}
                onDrop={(e) => {
                  if (!dragSectionSlug || dragSectionSlug === group.slug) return;
                  e.preventDefault();
                  setDragSectionOver(null);
                  // Reorder sections
                  const currentOrder = grouped.map((g) => g.slug);
                  const fromIdx = currentOrder.indexOf(dragSectionSlug);
                  const toIdx = currentOrder.indexOf(group.slug);
                  if (fromIdx >= 0 && toIdx >= 0) {
                    const next = [...currentOrder];
                    next.splice(fromIdx, 1);
                    next.splice(toIdx, 0, dragSectionSlug);
                    setSectionOrder(next);
                  }
                  setDragSectionSlug(null);
                }}
              >
                {/* Drop indicator */}
                {dragSectionOver === group.slug && (
                  <div className="mb-2 h-0.5 rounded-full bg-sky-400/60 shadow-[0_0_8px_2px_rgba(56,189,248,0.3)]" />
                )}
                {/* Section header — draggable */}
                <div
                  className="mb-3 flex cursor-grab items-center gap-3 active:cursor-grabbing"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", group.slug);
                    setDragSectionSlug(group.slug);
                  }}
                  onDragEnd={() => { setDragSectionSlug(null); setDragSectionOver(null); }}
                >
                  <div
                    className="h-px flex-1"
                    style={{ backgroundColor: group.accent + "30" }}
                  />
                  <span className="text-white/15 text-[10px] select-none">::</span>
                  <span
                    className="font-mono text-[10px] uppercase tracking-widest select-none"
                    style={{ color: group.accent }}
                  >
                    {group.name}
                  </span>
                  <span className="font-mono text-[9px] text-white/20">
                    {group.agents.length}
                  </span>
                  <span className="text-white/15 text-[10px] select-none">::</span>
                  <div
                    className="h-px flex-1"
                    style={{ backgroundColor: group.accent + "30" }}
                  />
                </div>
                {/* Cards */}
                <div className="flex flex-wrap justify-center" style={{ gap: containerGap }}>
                  {group.agents.map((a) => renderCard(a, nextIdx()))}
                </div>
              </div>
            ))}
            {/* Groupchats section */}
            {(onOpenGroupchat || onNewGroupchat) && (
              <div>
                <div className="mb-3 flex items-center gap-3">
                  <div className="h-px flex-1" style={{ backgroundColor: "#6366f130" }} />
                  <span className="font-mono text-[10px] uppercase tracking-widest text-indigo-400">
                    Groupchats
                  </span>
                  {groupchats.length > 0 && (
                    <span className="font-mono text-[9px] text-white/20">
                      {groupchats.length}
                    </span>
                  )}
                  {onNewGroupchat && (
                    <Tooltip label="Start new groupchat">
                      <button
                        type="button"
                        onClick={onNewGroupchat}
                        className="rounded border border-indigo-400/20 bg-indigo-500/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-indigo-300 transition hover:border-indigo-400/40 hover:bg-indigo-500/20"
                      >
                        + new
                      </button>
                    </Tooltip>
                  )}
                  <div className="h-px flex-1" style={{ backgroundColor: "#6366f130" }} />
                </div>
                <div className="flex flex-wrap justify-center" style={{ gap: containerGap }}>
                  {groupchats.map((gc) => (
                    <GroupchatCard
                      key={gc.groupchatId}
                      gc={gc}
                      agentNames={agentNameMap}
                      onClick={() => onOpenGroupchat?.(gc.pinnedName || gc.prompt.slice(0, 30), gc.groupchatId)}
                      tier={effectiveTier}
                    />
                  ))}
                  {groupchats.length === 0 && (
                    <div className="py-2 font-mono text-[10px] text-white/20">no recent groupchats</div>
                  )}
                </div>
              </div>
            )}

            {/* Add button at bottom */}
            <div className="flex justify-center" style={{ paddingTop: containerGap }}>
              <Tooltip label="Add agent to view" position="bottom">
                <button
                  type="button"
                  onClick={() => setShowPicker(true)}
                  className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/10 bg-zinc-900/40 transition-all hover:border-white/25 hover:bg-zinc-800/40"
                  style={{ width: sz.card, padding: sz.pad, gap: sz.gap }}
                >
                  <div
                    className="flex items-center justify-center rounded-full border-2 border-dashed border-white/10"
                    style={{ width: sz.avatar, height: sz.avatar }}
                  >
                    <span className="text-white/15" style={{ fontSize: sz.nameText * 1.5 }}>+</span>
                  </div>
                  <span className="font-mono uppercase tracking-wider text-white/20" style={{ fontSize: sz.monoText }}>
                    add agent
                  </span>
                </button>
              </Tooltip>
            </div>
          </div>
        ) : (
          // Flat layout (single office or sorted)
          <div className="space-y-6">
            <div className="flex flex-wrap items-start justify-center" style={{ gap: containerGap }}>
              {filtered.map((a, i) => renderCard(a, i))}
              <Tooltip label="Add agent to view" position="bottom">
                <button
                  type="button"
                  onClick={() => setShowPicker(true)}
                  className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/10 bg-zinc-900/40 transition-all hover:border-white/25 hover:bg-zinc-800/40"
                  style={{ width: sz.card, padding: sz.pad, gap: sz.gap }}
                >
                  <div
                    className="flex items-center justify-center rounded-full border-2 border-dashed border-white/10"
                    style={{ width: sz.avatar, height: sz.avatar }}
                  >
                    <span className="text-white/15" style={{ fontSize: sz.nameText * 1.5 }}>+</span>
                  </div>
                  <span className="font-mono uppercase tracking-wider text-white/20" style={{ fontSize: sz.monoText }}>
                    add agent
                  </span>
                </button>
              </Tooltip>
            </div>
            {/* Groupchats in flat view */}
            {(onOpenGroupchat || onNewGroupchat) && (
              <div>
                <div className="mb-3 flex items-center gap-3">
                  <div className="h-px flex-1" style={{ backgroundColor: "#6366f130" }} />
                  <span className="font-mono text-[10px] uppercase tracking-widest text-indigo-400">
                    Groupchats
                  </span>
                  {groupchats.length > 0 && (
                    <span className="font-mono text-[9px] text-white/20">
                      {groupchats.length}
                    </span>
                  )}
                  {onNewGroupchat && (
                    <Tooltip label="Start new groupchat">
                      <button
                        type="button"
                        onClick={onNewGroupchat}
                        className="rounded border border-indigo-400/20 bg-indigo-500/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-indigo-300 transition hover:border-indigo-400/40 hover:bg-indigo-500/20"
                      >
                        + new
                      </button>
                    </Tooltip>
                  )}
                  <div className="h-px flex-1" style={{ backgroundColor: "#6366f130" }} />
                </div>
                <div className="flex flex-wrap justify-center" style={{ gap: containerGap }}>
                  {groupchats.map((gc) => (
                    <GroupchatCard
                      key={gc.groupchatId}
                      gc={gc}
                      agentNames={agentNameMap}
                      onClick={() => onOpenGroupchat?.(gc.pinnedName || gc.prompt.slice(0, 30), gc.groupchatId)}
                      tier={effectiveTier}
                    />
                  ))}
                  {groupchats.length === 0 && (
                    <div className="py-2 font-mono text-[10px] text-white/20">no recent groupchats</div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Select mode bar */}
      {selectMode && (
        <div className="absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-indigo-400/30 bg-zinc-900/95 px-5 py-3 shadow-2xl backdrop-blur-sm">
          <span className="font-mono text-[11px] text-indigo-300">
            select mode
          </span>
          <span className="font-mono text-[11px] text-white/40">
            {selectedIds.size} agent{selectedIds.size !== 1 ? "s" : ""}
          </span>
          <button
            type="button"
            disabled={selectedIds.size < 2}
            onClick={() => {
              onNewGroupchat?.();
              exitSelectMode();
            }}
            className="rounded-lg border border-indigo-400/30 bg-indigo-500/20 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-indigo-200 transition hover:bg-indigo-500/30 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            start groupchat
          </button>
          <button
            type="button"
            onClick={exitSelectMode}
            className="font-mono text-[10px] text-white/30 hover:text-white/60"
          >
            cancel (esc)
          </button>
        </div>
      )}

      {/* Keyboard shortcut hints */}
      {!selectMode && (
        <div className="absolute bottom-2 right-3 flex gap-3 font-mono text-[8px] uppercase tracking-wider text-white/10">
          <span>/ search</span>
          <span>N groupchat</span>
          <span>G select agents</span>
          <span>shift+click prompt</span>
        </div>
      )}

      {showPicker && (
        <AddAgentPicker
          agents={available}
          onPick={onPin}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
