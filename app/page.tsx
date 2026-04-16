"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import paradiseRaw from "@/config/paradise.office.json";
import dontcallRaw from "@/config/dontcall.office.json";
import operationsRaw from "@/config/operations.office.json";
import stationRaw from "@/config/station.json";
import type {
  OfficeConfig,
  StationConfig,
  IndicatorKind,
} from "@/lib/office-types";
import Station from "@/components/pixi/Station";
import type { Task } from "@/components/tray/TaskTray";
import PromptBar from "@/components/prompt-bar/PromptBar";
import CommandPalette from "@/components/palette/CommandPalette";
import UsageTracker from "@/components/usage/UsageTracker";
import SpriteBubble from "@/components/sprite-bubble/SpriteBubble";
import ChatDock, { DockTabsProvider } from "@/components/dock/ChatDock";
import { useDockTabs } from "@/hooks/useDockTabs";
import AgentHoverCard from "@/components/canvas/AgentHoverCard";
import ActiveWarRooms from "@/components/events/ActiveWarRooms";
import NotificationCenter from "@/components/notifications/NotificationCenter";
import { useAmbientStream } from "@/hooks/useAmbientStream";

const offices: Record<string, OfficeConfig> = {
  paradise: paradiseRaw as OfficeConfig,
  dontcall: dontcallRaw as OfficeConfig,
  operations: operationsRaw as OfficeConfig,
};
const station = stationRaw as StationConfig;
const order = ["operations", "paradise", "dontcall"] as const;
type OfficeSlug = (typeof order)[number];

const ROSTER_POLL_MS = 5_000;

type RosterEntry = {
  agent: {
    id: string;
    deskId: string;
    name: string;
    role: string;
    isReal: boolean;
    model: string | null;
  };
  current: {
    assignmentId: string;
    assignedAt: number;
    task: { id: string; title: string; body: string };
    runId: string | null;
    runStatus: string | null;
    acknowledgedAt: number | null;
    inputQuestion: string | null;
  } | null;
  queueDepth: number;
};

export default function Home() {
  return (
    <DockTabsProvider>
      <HomeInner />
    </DockTabsProvider>
  );
}

function HomeInner() {
  const { openOrFocus, openWarRoom, focusedTab } = useDockTabs();

  // The office whose sidebar + roster data is shown. Always a real slug (never null).
  const [sidebarSlug, setSidebarSlug] = useState<OfficeSlug>("paradise");
  // Whether the Pixi camera is focused on a module or in overview.
  // null = overview (camera fits both modules), string = slug of focused module.
  const [focusedModule, setFocusedModule] = useState<OfficeSlug | null>(null);

  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedDeskId, setSelectedDeskId] = useState<string | null>(null);
  const [showGrid, setShowGrid] = useState(false);

  const [rosterEntries, setRosterEntries] = useState<RosterEntry[] | null>(
    null,
  );
  const [bubble, setBubble] = useState<{
    deskId: string;
    officeSlug: OfficeSlug;
    x: number;
    y: number;
    mode: "task" | "reply";
    runId?: string | null;
  } | null>(null);
  const [hoverCard, setHoverCard] = useState<{
    deskId: string;
    officeSlug: OfficeSlug;
    x: number;
    y: number;
  } | null>(null);
  const agentPositionsRef = useRef<Map<string, { clientX: number; clientY: number }>>(new Map());

  // Ambient stream — track active runs for non-focused agents
  const activeRuns = useMemo(() => {
    return (rosterEntries ?? [])
      .filter((e) => {
        const st = e.current?.runStatus;
        return st === "running" || st === "starting";
      })
      .map((e) => ({
        agentId: e.agent.id,
        deskId: e.agent.deskId,
        runId: e.current?.runId ?? "",
      }))
      .filter((r) => r.runId);
  }, [rosterEntries]);
  const ambientLines = useAmbientStream(activeRuns, focusedTab?.agentId ?? null);

  // Context usage for ⚠ overlay — poll inspector for running agents
  const [contextUsage, setContextUsage] = useState<
    ReadonlyMap<string, { model: string | null; tokens: number }>
  >(new Map());

  useEffect(() => {
    const runningEntries = (rosterEntries ?? []).filter(
      (e) => e.current?.runStatus === "running" || e.current?.runStatus === "starting",
    );
    if (runningEntries.length === 0) return;
    let alive = true;
    (async () => {
      const updates = new Map<string, { model: string | null; tokens: number }>();
      await Promise.all(
        runningEntries.map(async (entry) => {
          try {
            const slug = order.find((s) => offices[s].agents.some((a) => a.id === entry.agent.id));
            if (!slug) return;
            const res = await fetch(
              `/api/inspector?office=${encodeURIComponent(slug)}&deskId=${encodeURIComponent(entry.agent.deskId)}`,
            );
            if (!res.ok) return;
            const json = (await res.json()) as {
              agent: { model: string | null };
              context: { tokens: number; limit: number; pct: number } | null;
            };
            if (json.context) {
              updates.set(entry.agent.id, {
                model: json.agent.model,
                tokens: json.context.tokens,
              });
            }
          } catch {
            // ignore
          }
        }),
      );
      if (alive && updates.size > 0) {
        setContextUsage((prev) => {
          const next = new Map(prev);
          for (const [k, v] of updates) next.set(k, v);
          return next;
        });
      }
    })();
    return () => { alive = false; };
  }, [rosterEntries]);

  // Restore sidebar slug + desk selection from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem("ri-office") as OfficeSlug | null;
    if (stored === "paradise" || stored === "dontcall" || stored === "operations") {
      setSidebarSlug(stored);
      const storedDesk = localStorage.getItem(`ri-desk-${stored}`);
      if (storedDesk) setSelectedDeskId(storedDesk);
    }
    const storedFocus = localStorage.getItem(
      "ri-focus",
    ) as OfficeSlug | "overview" | null;
    if (storedFocus === "paradise" || storedFocus === "dontcall" || storedFocus === "operations") {
      setFocusedModule(storedFocus);
    }
  }, []);

  const focusModule = useCallback((slug: OfficeSlug | null) => {
    setFocusedModule(slug);
    localStorage.setItem("ri-focus", slug ?? "overview");
    if (slug) {
      setSidebarSlug(slug);
      localStorage.setItem("ri-office", slug);
      const storedDesk = localStorage.getItem(`ri-desk-${slug}`);
      setSelectedDeskId(storedDesk ?? null);
    }
    setBubble(null);
  }, []);

  // 1/2/3 keyboard shortcuts to jump between offices
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
      const idx = parseInt(e.key) - 1;
      if (idx >= 0 && idx < order.length) focusModule(order[idx]);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [focusModule]);

  const selectDesk = useCallback(
    (deskId: string | null, officeSlug?: OfficeSlug) => {
      const slug = officeSlug ?? sidebarSlug;
      if (deskId) {
        setSidebarSlug(slug);
        localStorage.setItem("ri-office", slug);
        localStorage.setItem(`ri-desk-${slug}`, deskId);
      } else {
        localStorage.removeItem(`ri-desk-${sidebarSlug}`);
      }
      setSelectedDeskId(deskId);
    },
    [sidebarSlug],
  );

  // G toggles grid overlay
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "g") return;
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      setShowGrid((prev) => !prev);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Fetch tasks for sidebar office
  useEffect(() => {
    let alive = true;
    (async () => {
      const tRes = await fetch(`/api/tasks?office=${sidebarSlug}`).then((r) =>
        r.json(),
      );
      if (!alive) return;
      setTasks(
        (tRes.tasks ?? []).map(
          (t: { id: string; title: string; body: string }) => ({
            id: t.id,
            title: t.title,
            body: t.body,
          }),
        ),
      );
    })();
    return () => {
      alive = false;
    };
  }, [sidebarSlug]);

  // Poll roster for sidebar slug — drives Pixi indicators too
  const refetchRoster = useCallback(async () => {
    try {
      const results = await Promise.all(
        order.map((slug) =>
          fetch(`/api/roster?office=${encodeURIComponent(slug)}`, { cache: "no-store" })
            .then((r) => r.ok ? r.json() as Promise<{ entries: RosterEntry[] }> : null)
            .catch(() => null),
        ),
      );
      const merged = results.flatMap((r) => r?.entries ?? []);
      setRosterEntries(merged);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void refetchRoster();
    const id = setInterval(refetchRoster, ROSTER_POLL_MS);
    return () => clearInterval(id);
  }, [refetchRoster]);

  const busyDeskIds = useMemo(() => {
    const s = new Set<string>();
    for (const e of rosterEntries ?? []) {
      const st = e.current?.runStatus;
      if (st === "running" || st === "starting" || st === "awaiting_input") {
        s.add(e.agent.deskId);
      }
    }
    return s;
  }, [rosterEntries]);

  const agentStatus = useMemo(() => {
    const m = new Map<string, IndicatorKind>();
    for (const e of rosterEntries ?? []) {
      const c = e.current;
      if (!c) continue;
      if (c.runStatus === "awaiting_input") {
        m.set(e.agent.deskId, "awaiting_input");
      } else if (c.runStatus === "done" && !c.acknowledgedAt) {
        m.set(e.agent.deskId, "done_unacked");
      }
    }
    return m;
  }, [rosterEntries]);

  const deskRunStatus = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of rosterEntries ?? []) {
      const status = e.current?.runStatus;
      if (!status) continue;
      if (status === "done") {
        // Only colour the tab while unacknowledged
        if (!e.current?.acknowledgedAt) m.set(e.agent.deskId, "done_unacked");
      } else {
        m.set(e.agent.deskId, status);
      }
    }
    return m;
  }, [rosterEntries]);

  // Desk→agent lookup built from ALL offices (for cross-module interactions)
  const agentByDesk = useMemo(() => {
    const m = new Map<
      string,
      { id: string; isReal: boolean; officeSlug: OfficeSlug }
    >();
    for (const slug of order) {
      for (const a of offices[slug].agents) {
        m.set(a.deskId, {
          id: a.id,
          isReal: a.isReal,
          officeSlug: slug,
        });
      }
    }
    return m;
  }, []);

  const runByDesk = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const e of rosterEntries ?? []) {
      m.set(e.agent.deskId, e.current?.runId ?? null);
    }
    return m;
  }, [rosterEntries]);

  const handleAgentClick = useCallback(
    (
      officeSlug: string,
      deskId: string,
      clientX: number,
      clientY: number,
      shiftKey?: boolean,
    ) => {
      const slug = officeSlug as OfficeSlug;
      // Keep sidebar context in sync
      if (slug !== sidebarSlug) {
        setSidebarSlug(slug);
        localStorage.setItem("ri-office", slug);
      }
      const kind = agentStatus.get(deskId);
      const agent = agentByDesk.get(deskId);

      // Shift+click → quick-cast bubble (task mode)
      if (shiftKey) {
        if (!agent) return;
        setBubble({
          deskId,
          officeSlug: slug,
          x: clientX,
          y: clientY,
          mode: "task",
        });
        return;
      }

      // Awaiting input → reply bubble
      if (kind === "awaiting_input") {
        setBubble({
          deskId,
          officeSlug: slug,
          x: clientX,
          y: clientY,
          mode: "reply",
          runId: runByDesk.get(deskId) ?? null,
        });
        return;
      }

      // Done unacked → ack immediately then open tab
      if (kind === "done_unacked") {
        const runId = runByDesk.get(deskId);
        if (runId) {
          void fetch(`/api/runs/${encodeURIComponent(runId)}/ack`, { method: "POST" })
            .then(() => refetchRoster())
            .catch(() => {});
        }
      }

      // All other clicks → open/focus dock tab
      if (!agent) return;
      const agentConfig = offices[slug]?.agents.find((a) => a.deskId === deskId);
      openOrFocus({
        id: agent.id,
        agentId: agent.id,
        deskId,
        officeSlug: slug,
        kind: "1:1",
        label: agentConfig?.name ?? deskId,
      });
    },
    [agentStatus, agentByDesk, runByDesk, sidebarSlug, openOrFocus, refetchRoster],
  );

  const handleDeskDrop = useCallback(
    async (
      officeSlug: string,
      deskId: string,
      e: React.DragEvent<HTMLDivElement>,
    ) => {
      const slug = officeSlug as OfficeSlug;
      const taskId = e.dataTransfer.getData("application/x-robot-task");
      if (!taskId) return;
      const agent = agentByDesk.get(deskId);
      if (!agent) return;

      const droppedTask = tasks.find((t) => t.id === taskId);
      setTasks((prev) => prev.filter((t) => t.id !== taskId));

      const res = await fetch("/api/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, agentId: agent.id, officeSlug: slug }),
      });
      if (!res.ok) {
        const tRes = await fetch(`/api/tasks?office=${sidebarSlug}`).then(
          (r) => r.json(),
        );
        setTasks(tRes.tasks ?? []);
        return;
      }
      const { assignment } = (await res.json()) as {
        assignment: { id: string };
      };
      if (agent.isReal && droppedTask) {
        const prompt = droppedTask.body
          ? `${droppedTask.title}\n\n${droppedTask.body}`
          : droppedTask.title;
        await fetch("/api/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            assignmentId: assignment.id,
            agentId: agent.id,
            officeSlug: slug,
            prompt,
          }),
        }).catch(() => {});
      }
      void refetchRoster();
    },
    [agentByDesk, sidebarSlug, selectedDeskId, tasks, refetchRoster],
  );

  const submitBubble = useCallback(
    async (text: string) => {
      if (!bubble) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      if (bubble.mode === "reply" && bubble.runId) {
        await fetch(
          `/api/runs/${encodeURIComponent(bubble.runId)}/reply`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reply: trimmed }),
          },
        ).catch(() => {});
        setBubble(null);
        void refetchRoster();
      } else if (bubble.mode === "task") {
        const agent = agentByDesk.get(bubble.deskId);
        if (!agent) return;
        await fetch("/api/quick-run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            officeSlug: bubble.officeSlug,
            agentId: agent.id,
            prompt: trimmed,
          }),
        }).catch(() => {});
        setBubble(null);
        if (agent.isReal) selectDesk(bubble.deskId, bubble.officeSlug);
        void refetchRoster();
      }
    },
    [bubble, agentByDesk, selectDesk, refetchRoster],
  );

  const handleAgentMove = useCallback(
    async (
      officeSlug: string,
      deskId: string,
      gridX: number,
      gridY: number,
    ) => {
      try {
        const res = await fetch("/api/desks/move", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ officeSlug, deskId, gridX, gridY }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          console.error("desk move failed:", err.error ?? res.status);
        }
      } catch (e) {
        console.error("desk move network error:", e);
      }
    },
    [],
  );

  const officeContainerRef = useRef<HTMLDivElement | null>(null);
  const sidebarOffice = offices[sidebarSlug];

  const allAgentsForDock = useMemo(() => {
    return order.flatMap((slug) =>
      offices[slug].agents.map((a) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        deskId: a.deskId,
        isReal: a.isReal,
        officeSlug: slug,
      })),
    );
  }, []);

  // Lookup maps for ActiveWarRooms
  const agentNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const slug of order) {
      for (const a of offices[slug].agents) m.set(a.id, a.name);
    }
    return m;
  }, []);
  const officeNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const slug of order) m.set(slug, offices[slug].name);
    return m;
  }, []);
  const officeAccentMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const slug of order) m.set(slug, offices[slug].theme.accent);
    return m;
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col bg-black text-white">
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-2 text-sm">
        <div className="font-mono tracking-tight">robots-in-a-house</div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <button
              onClick={() => {
                const idx = focusedModule ? order.indexOf(focusedModule) : 0;
                focusModule(order[(idx - 1 + order.length) % order.length]);
              }}
              className="rounded px-1.5 py-0.5 font-mono text-xs opacity-50 transition hover:bg-white/10 hover:opacity-100"
              title="Previous office"
            >
              ‹
            </button>
            <div className="font-mono text-xs opacity-60">
              station: {station.name}
              {focusedModule ? ` · ${offices[focusedModule].name}` : " · overview"}
            </div>
            <button
              onClick={() => {
                const idx = focusedModule ? order.indexOf(focusedModule) : -1;
                focusModule(order[(idx + 1) % order.length]);
              }}
              className="rounded px-1.5 py-0.5 font-mono text-xs opacity-50 transition hover:bg-white/10 hover:opacity-100"
              title="Next office"
            >
              ›
            </button>
          </div>
        </div>
      </header>
      <div className="flex flex-1 flex-col overflow-hidden">
          <main
            className="relative min-h-0 flex-1 overflow-hidden"
            ref={officeContainerRef}
          >
            <Station
              station={station}
              offices={offices}
              focusedModule={focusedModule}
              busyDeskIds={busyDeskIds}
              agentStatus={agentStatus}
              selectedDeskId={selectedDeskId}
              onDeskSelect={(deskId) => selectDesk(deskId)}
              onAgentClick={handleAgentClick}
              onDeskDrop={handleDeskDrop}
              onAgentMove={handleAgentMove}
              onModuleFocus={(slug) => focusModule(slug as OfficeSlug)}
              onWarRoomClick={(slug) => {
                if (slug === "paradise" || slug === "dontcall" || slug === "operations") {
                  const office = offices[slug];
                  openWarRoom(slug, office ? `${office.name} War Room` : "War Room");
                }
              }}
              onAgentHover={(officeSlug, deskId, clientX, clientY) => {
                setHoverCard({ deskId, officeSlug: officeSlug as OfficeSlug, x: clientX, y: clientY });
              }}
              onAgentHoverOut={() => setHoverCard(null)}
              onAgentPositions={(positions) => {
                agentPositionsRef.current = positions;
              }}
              contextUsage={contextUsage}
              showGrid={showGrid}
            />
            {/* Active war rooms — top-right overlay */}
            <div className="pointer-events-auto absolute right-3 top-3 z-20 w-64">
              <ActiveWarRooms
                agentNames={agentNameMap}
                officeNames={officeNameMap}
                officeAccents={officeAccentMap}
                onOpen={(slug, meetingId) => {
                  const office = offices[slug];
                  openWarRoom(slug, office ? `${office.name} War Room` : "War Room", meetingId);
                }}
              />
            </div>
            {/* Notifications — top-left overlay */}
            <div className="pointer-events-auto absolute left-3 top-3 z-20 w-64">
              <NotificationCenter
                officeNames={officeNameMap}
                officeAccents={officeAccentMap}
                onOpenWarRoom={(slug, meetingId) => {
                  const office = offices[slug];
                  openWarRoom(
                    slug,
                    office ? `${office.name} War Room` : "War Room",
                    meetingId,
                  );
                }}
                onOpenAgent={(slug, agentId) => {
                  const agentConfig = offices[slug]?.agents.find((a) => a.id === agentId);
                  if (!agentConfig) return;
                  openOrFocus({
                    id: agentId,
                    agentId,
                    deskId: agentConfig.deskId,
                    officeSlug: slug,
                    kind: "1:1",
                    label: agentConfig.name,
                  });
                }}
              />
            </div>
            {bubble && (
              <SpriteBubble
                key={`${bubble.deskId}:${bubble.mode}`}
                x={bubble.x}
                y={bubble.y}
                mode={bubble.mode}
                containerRef={officeContainerRef}
                onSubmit={submitBubble}
                onDismiss={() => setBubble(null)}
              />
            )}
            {/* Ambient bubbles — one per active non-focused agent */}
            {Array.from(ambientLines.values()).map((line) => {
              const pos = agentPositionsRef.current.get(line.agentId);
              if (!pos) return null;
              return (
                <SpriteBubble
                  key={`ambient:${line.agentId}`}
                  mode="ambient"
                  x={pos.clientX}
                  y={pos.clientY}
                  text={line.lastLine}
                  containerRef={officeContainerRef}
                  onDismiss={() => {}} // ambient auto-dismisses itself
                />
              );
            })}

            {/* Office pill switcher — bottom-center of canvas */}
            <div className="pointer-events-auto absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/10 bg-black/60 px-2 py-1.5 backdrop-blur-sm">
              {order.map((slug, i) => {
                const office = offices[slug];
                const accent = office.theme.accent;
                const active = focusedModule === slug;
                const hasBusy = [...busyDeskIds].some((deskId) =>
                  office.desks.some((d) => d.id === deskId),
                );
                return (
                  <button
                    key={slug}
                    onClick={() => focusModule(slug)}
                    title={`${office.name} (${i + 1})`}
                    className="flex items-center gap-1.5 rounded-full px-3 py-1 font-mono text-[10px] uppercase tracking-wider transition-all"
                    style={
                      active
                        ? { backgroundColor: accent + "22", color: accent, borderColor: accent + "55", border: "1px solid" }
                        : { color: "rgba(255,255,255,0.35)" }
                    }
                  >
                    {hasBusy && !active && (
                      <span
                        className="inline-block h-1 w-1 animate-pulse rounded-full"
                        style={{ backgroundColor: accent }}
                      />
                    )}
                    <span>{office.name}</span>
                    <span className="opacity-30">{i + 1}</span>
                  </button>
                );
              })}
            </div>
          </main>
          {hoverCard && (() => {
            const agent = agentByDesk.get(hoverCard.deskId);
            if (!agent) return null;
            const agentConfig = offices[hoverCard.officeSlug]?.agents.find(
              (a) => a.deskId === hoverCard.deskId,
            );
            const rosterEntry = rosterEntries?.find(
              (e) => e.agent.deskId === hoverCard.deskId,
            );
            if (!agentConfig) return null;
            return (
              <AgentHoverCard
                agent={{
                  deskId: hoverCard.deskId,
                  officeSlug: hoverCard.officeSlug,
                  name: agentConfig.name,
                  role: agentConfig.role,
                  isReal: agentConfig.isReal,
                  model: agentConfig.model ?? null,
                }}
                run={rosterEntry ? {
                  runStatus: rosterEntry.current?.runStatus ?? null,
                  task: rosterEntry.current?.task ? { title: rosterEntry.current.task.title } : null,
                  tokens: null,
                } : null}
                queueDepth={rosterEntry?.queueDepth ?? 0}
                anchorX={hoverCard.x}
                anchorY={hoverCard.y}
                onDismiss={() => setHoverCard(null)}
              />
            );
          })()}
          <UsageTracker />
          <ChatDock
            agents={allAgentsForDock}
            rosterEntries={rosterEntries ?? []}
            offices={offices}
            deskRunStatus={deskRunStatus}
            onAckDesk={(deskId) => {
              const runId = runByDesk.get(deskId);
              if (runId) {
                void fetch(`/api/runs/${encodeURIComponent(runId)}/ack`, { method: "POST" })
                  .then(() => refetchRoster())
                  .catch(() => {});
              }
            }}
          />
          <PromptBar
            agents={sidebarOffice.agents}
            officeSlug={sidebarSlug}
            onSent={({ deskId, isReal }) => {
              if (isReal) selectDesk(deskId);
              void refetchRoster();
            }}
          />
      </div>
      <CommandPalette
        slug={sidebarSlug}
        allOffices={order.map((s) => ({ slug: s, name: offices[s].name, agents: offices[s].agents }))}
        onSwitchOffice={(slug) => focusModule(slug as OfficeSlug)}
        onFocusAgent={(deskId) => selectDesk(deskId)}
      />
    </div>
  );
}
