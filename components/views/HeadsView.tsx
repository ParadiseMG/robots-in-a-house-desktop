"use client";

import { useRef, useState } from "react";

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
};

type Props = {
  heads: QuickViewAgent[];
  pinnedIds: string[];
  allAgents: QuickViewAgent[];
  tabOrder: string[]; // agent IDs in dock tab order
  onChat: (agent: QuickViewAgent) => void;
  onPin: (agentId: string) => void;
  onUnpin: (agentId: string) => void;
  onReorder: (fromId: string, toId: string) => void;
};

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

// Size presets by scale tier
// spriteScale is derived: avatar / FRAME.h gives 1:1 fit, then * 1.15 to fill the circle nicely
const SIZES = {
  full:   { card: 224, avatar: 96, pad: 24, gap: 12, nameText: 16, subText: 11, monoText: 10, tinyText: 9, dotSize: 12, addH: 248 },
  medium: { card: 180, avatar: 72, pad: 16, gap: 10, nameText: 14, subText: 10, monoText: 9,  tinyText: 8, dotSize: 10, addH: 200 },
  small:  { card: 140, avatar: 56, pad: 12, gap: 8,  nameText: 12, subText: 9,  monoText: 8,  tinyText: 7, dotSize: 8,  addH: 160 },
  tiny:   { card: 110, avatar: 44, pad: 8,  gap: 6,  nameText: 11, subText: 8,  monoText: 7,  tinyText: 6, dotSize: 6, addH: 130 },
} as const;

/** Compute background-size and background-position to render a portrait
 *  of the character frame centered inside a circle of `avatar` px diameter.
 *  Returns inline style props for a wrapper (avatar×avatar, flex-centered)
 *  and an inner div (charW×avatar) that only shows the character column. */
function spriteStyle(avatar: number, premade: string): {
  wrapper: React.CSSProperties;
  inner: React.CSSProperties;
} {
  // Scale so the 32px-tall character fills the avatar height exactly
  const scale = avatar / FRAME.h;
  const charW = FRAME.w * scale; // narrow column — no neighbor bleed
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

type SizeTier = keyof typeof SIZES;

function getTier(count: number): SizeTier {
  if (count <= 5) return "full";
  if (count <= 8) return "medium";
  if (count <= 12) return "small";
  return "tiny";
}

function AgentCard({
  agent,
  onChat,
  onRemove,
  tier,
}: {
  agent: QuickViewAgent;
  onChat: () => void;
  onRemove?: () => void;
  tier: SizeTier;
}) {
  const sz = SIZES[tier];
  const st = statusLabel(agent.status, agent.activeDelegations);
  return (
    <button
      type="button"
      onClick={onChat}
      data-desk-id={agent.deskId}
      className="group relative flex flex-col items-center rounded-xl border border-white/10 bg-zinc-900/80 shadow-lg backdrop-blur-sm transition-all hover:border-white/25 hover:bg-zinc-800/80 hover:shadow-xl"
      style={{
        width: sz.card,
        padding: sz.pad,
        gap: sz.gap,
        borderTopColor: agent.accent + "88",
        borderTopWidth: 2,
      }}
    >
      {/* Remove button for pinned (non-head) agents */}
      {onRemove && (
        <span
          role="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="absolute right-1.5 top-1.5 rounded px-1 py-0.5 font-mono text-white/20 opacity-0 transition group-hover:opacity-100 hover:text-white/60"
          style={{ fontSize: sz.monoText }}
          title="Remove from quick view"
        >
          x
        </span>
      )}

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

      {/* Name + office */}
      <div className="w-full text-center">
        <div className="truncate font-medium text-white" style={{ fontSize: sz.nameText }}>{agent.name}</div>
        <div className="truncate text-white/50" style={{ fontSize: sz.subText, marginTop: 2 }}>{agent.officeName}</div>
      </div>

      {/* Status */}
      <div className="flex items-center gap-1 font-mono uppercase tracking-wider" style={{ fontSize: sz.monoText }}>
        <span className={st.color}>{st.text}</span>
        {agent.activeDelegations > 0 && (
          <span className="text-purple-300/60">
            ({agent.activeDelegations})
          </span>
        )}
      </div>

      {/* Bottom line: team size for heads, role for others */}
      <div className="truncate font-mono uppercase tracking-wider text-white/25" style={{ fontSize: sz.tinyText }}>
        {agent.isHead
          ? `${agent.teamSize} agent${agent.teamSize !== 1 ? "s" : ""}`
          : agent.role}
      </div>
    </button>
  );
}

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

  // Group by office
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
            add to quick view
          </span>
          <button type="button" onClick={onClose} className="text-white/30 hover:text-white text-sm">
            x
          </button>
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
                    onClick={() => {
                      onPick(agent.id);
                      onClose();
                    }}
                    className="flex w-full items-center gap-3 rounded-lg border border-white/5 px-3 py-2 text-left transition hover:border-white/15 hover:bg-white/5"
                  >
                    {/* Mini sprite */}
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

export default function HeadsView({ heads, pinnedIds, allAgents, tabOrder, onChat, onPin, onUnpin, onReorder }: Props) {
  const [showPicker, setShowPicker] = useState(false);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);

  // Build ordered list: match dock tab order, then heads, then pinned
  const headIds = new Set(heads.filter((h) => h.isHead).map((h) => h.id));
  const allVisible = [
    ...heads.filter((h) => h.isHead),
    ...pinnedIds
      .filter((id) => !headIds.has(id))
      .map((id) => allAgents.find((a) => a.id === id))
      .filter(Boolean) as QuickViewAgent[],
  ];

  // Sort to match dock tab order — tabbed agents first (in tab order),
  // then remaining agents in their default order
  const visible = (() => {
    if (tabOrder.length === 0) return allVisible;
    const tabMap = new Map(tabOrder.map((id, i) => [id, i]));
    const sorted = [...allVisible].sort((a, b) => {
      const ai = tabMap.has(a.id) ? tabMap.get(a.id)! : tabOrder.length + allVisible.indexOf(a);
      const bi = tabMap.has(b.id) ? tabMap.get(b.id)! : tabOrder.length + allVisible.indexOf(b);
      return ai - bi;
    });
    return sorted;
  })();

  // Available to pin: all agents not already visible
  const visibleIds = new Set(visible.map((a) => a.id));
  const available = allAgents.filter((a) => !visibleIds.has(a.id));

  const totalCards = visible.length + 1;
  const tier = getTier(totalCards);
  const sz = SIZES[tier];
  const containerGap = tier === "full" ? 24 : tier === "medium" ? 18 : tier === "small" ? 14 : 10;

  const handleDrop = (targetId: string) => {
    const fromId = dragIdRef.current;
    if (!fromId || fromId === targetId) return;
    onReorder(fromId, targetId);
  };

  return (
    <div className="flex h-full w-full items-center justify-center overflow-auto p-6">
      <div
        className="flex flex-wrap items-stretch justify-center"
        style={{ gap: containerGap }}
      >
        {visible.map((agent) => (
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
            className={`relative transition-opacity ${draggingId === agent.id ? "opacity-40" : ""}`}
          >
            {dragOverId === agent.id && (
              <div className="pointer-events-none absolute -left-[6px] inset-y-0 z-10 flex items-center">
                <div className="h-full w-[3px] rounded-full bg-sky-400 shadow-[0_0_8px_2px_rgba(56,189,248,0.5)]" />
              </div>
            )}
            <AgentCard
              agent={agent}
              tier={tier}
              onChat={() => onChat(agent)}
              onRemove={!agent.isHead ? () => onUnpin(agent.id) : undefined}
            />
          </div>
        ))}

        {/* Add agent button */}
        <button
          type="button"
          onClick={() => setShowPicker(true)}
          className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/10 bg-zinc-900/40 transition-all hover:border-white/25 hover:bg-zinc-800/40"
          style={{ width: sz.card, padding: sz.pad, gap: sz.gap }}
          title="Add agent to quick view"
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
      </div>

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
