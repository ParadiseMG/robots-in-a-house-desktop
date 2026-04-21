"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  OfficeConfig,
  StationConfig,
  IndicatorKind,
} from "@/lib/office-types";
import Station from "@/components/pixi/Station";
import type { Task } from "@/components/tray/TaskTray";
import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import PromptBar from "@/components/prompt-bar/PromptBar";
import CommandPalette from "@/components/palette/CommandPalette";
import UsageTracker from "@/components/usage/UsageTracker";
import SpriteBubble from "@/components/sprite-bubble/SpriteBubble";
import ChatDock, { DockTabsProvider } from "@/components/dock/ChatDock";
import HeadsView from "@/components/views/HeadsView";
import { useDockTabs } from "@/hooks/useDockTabs";
import AgentHoverCard from "@/components/canvas/AgentHoverCard";
import ActiveGroupchats from "@/components/events/ActiveGroupchats";
import OfficeTodos from "@/components/todos/OfficeTodos";
import Tooltip from "@/components/ui/Tooltip";
import HealthBanner from "@/components/health/HealthBanner";
import WelcomePrompt from "@/components/health/WelcomePrompt";
import { useAmbientStream } from "@/hooks/useAmbientStream";
import confetti from "canvas-confetti";

const DEFAULT_STATION: StationConfig = {
  slug: "my-station",
  name: "My Station",
  modules: [],
  background: { kind: "starfield", seed: 1, density: 0.0008 },
};

/** Build a station config dynamically from loaded offices + optional station.json overrides. */
function buildStation(
  slugs: string[],
  offices: Record<string, OfficeConfig>,
  stationOverride?: StationConfig | null,
): StationConfig {
  const base = stationOverride ?? DEFAULT_STATION;

  // Start with modules from station.json that still exist on disk
  const existingModules = new Map(
    base.modules.map((m) => [m.office, m]),
  );
  const modules = [...base.modules.filter((m) => slugs.includes(m.office))];
  let nextX = modules.reduce((max, m) => Math.max(max, m.offsetX + 800), 0);

  // Add any offices that aren't in the base config
  for (const slug of slugs) {
    if (existingModules.has(slug)) continue;
    modules.push({
      office: slug,
      offsetX: nextX,
      offsetY: 0,
      accent: offices[slug]?.theme?.accent ?? "#5aa0ff",
    });
    nextX += 800;
  }

  return { ...base, modules };
}

const ROSTER_POLL_MS = 5_000;

type RosterEntry = {
  agent: {
    id: string;
    deskId: string;
    name: string;
    role: string;
    isReal: boolean;
    isHead?: boolean;
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
  activeDelegations?: number;
};

/** Maps an agent role string to a role icon emoji. */
function roleIcon(role: string): string | undefined {
  const r = role.toLowerCase();
  if (/design|visual|art|creative/.test(r)) return "🎨";
  if (/engineer|infra|deploy|environment/.test(r)) return "⚙️";
  if (/bug|patch|fix/.test(r)) return "🔧";
  if (/director|lead|head/.test(r)) return "📋";
  if (/sales|marketing|promo/.test(r)) return "📢";
  if (/monitor|watch/.test(r)) return "👁";
  return undefined;
}

export default function Home() {
  return (
    <DockTabsProvider>
      <HomeInner />
    </DockTabsProvider>
  );
}

function HomeInner() {
  const { openOrFocus, openGroupchat, focusedTab, tabs, reorder } = useDockTabs();

  // Dynamic office loading
  const [offices, setOffices] = useState<Record<string, OfficeConfig>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [officesLoaded, setOfficesLoaded] = useState(false);
  const [station, setStation] = useState<StationConfig>(DEFAULT_STATION);

  useEffect(() => {
    fetch("/api/offices")
      .then((r) => r.json())
      .then((data: { offices: Record<string, OfficeConfig>; slugs: string[]; station?: StationConfig | null }) => {
        setOffices(data.offices);
        setOrder(data.slugs);
        setStation(buildStation(data.slugs, data.offices, data.station));
        setOfficesLoaded(true);
        // Redirect to setup if no offices exist
        if (data.slugs.length === 0) {
          window.location.href = "/setup";
        }
      })
      .catch(() => setOfficesLoaded(true));
  }, []);

  // The office whose sidebar + roster data is shown. Always a real slug (never null).
  const [sidebarSlug, setSidebarSlug] = useState<string>("");
  // Whether the Pixi camera is focused on a module or in overview.
  // null = overview (camera fits both modules), string = slug of focused module.
  const [focusedModule, setFocusedModule] = useState<string | null>(null);

  // Set initial sidebar slug once offices load
  useEffect(() => {
    if (order.length > 0 && !sidebarSlug) {
      setSidebarSlug(order[0]);
    }
  }, [order, sidebarSlug]);

  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedDeskId, setSelectedDeskId] = useState<string | null>(null);
  const [showGrid, setShowGrid] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [viewMode, setViewMode] = useState<"canvas" | "grid">(() => {
    if (typeof window === "undefined") return "canvas";
    return (localStorage.getItem("ri-view-mode") as "canvas" | "grid") ?? "canvas";
  });

  const [rosterEntries, setRosterEntries] = useState<RosterEntry[] | null>(
    null,
  );
  const [bubble, setBubble] = useState<{
    deskId: string;
    officeSlug: string;
    x: number;
    y: number;
    mode: "task" | "reply";
    runId?: string | null;
  } | null>(null);
  const [hoverCard, setHoverCard] = useState<{
    deskId: string;
    officeSlug: string;
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
  // Agent IDs (not desk IDs) that are currently busy — passed to useAmbientStream for thinking placeholders
  const busyAgentIds = useMemo(() => {
    const s = new Set<string>();
    for (const e of rosterEntries ?? []) {
      const st = e.current?.runStatus;
      if (st === "running" || st === "starting" || st === "awaiting_input") {
        s.add(e.agent.id);
      }
    }
    return s;
  }, [rosterEntries]);

  const ambientLines = useAmbientStream(activeRuns, focusedTab?.agentId ?? null, busyAgentIds);

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
            const slug = order.find((s) => offices[s]?.agents.some((a) => a.id === entry.agent.id));
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
    if (order.length === 0) return;
    const stored = localStorage.getItem("ri-office") as string | null;
    if (stored && order.includes(stored)) {
      setSidebarSlug(stored);
      const storedDesk = localStorage.getItem(`ri-desk-${stored}`);
      if (storedDesk) setSelectedDeskId(storedDesk);
    }
    const storedFocus = localStorage.getItem(
      "ri-focus",
    ) as string | "overview" | null;
    if (storedFocus && order.includes(storedFocus)) {
      setFocusedModule(storedFocus);
    }
  }, [order]);

  const focusModule = useCallback((slug: string | null) => {
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
  }, [focusModule, order]);

  const selectDesk = useCallback(
    (deskId: string | null, officeSlug?: string) => {
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

  // G toggles grid overlay (canvas view only — grid view uses G for select mode)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (viewMode !== "canvas") return;
      if (e.key.toLowerCase() !== "g") return;
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      setShowGrid((prev) => !prev);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [viewMode]);

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
    if (order.length === 0) return;
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
  }, [order]);

  useVisibleInterval(() => { void refetchRoster(); }, ROSTER_POLL_MS, [refetchRoster]);

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
      } else if (c.runStatus === "error") {
        m.set(e.agent.deskId, "error");
      }
    }
    return m;
  }, [rosterEntries]);

  // Fire confetti over the agent card/sprite that just finished
  const prevRunStatuses = useRef(new Map<string, string>());
  useEffect(() => {
    if (!rosterEntries) return;
    const justFinished: string[] = [];
    for (const e of rosterEntries) {
      const c = e.current;
      if (!c) continue;
      const prev = prevRunStatuses.current.get(e.agent.deskId);
      if (
        c.runStatus === "done" &&
        prev &&
        prev !== "done" &&
        !c.acknowledgedAt
      ) {
        justFinished.push(e.agent.deskId);
      }
      if (c.runStatus) prevRunStatuses.current.set(e.agent.deskId, c.runStatus);
    }
    for (const deskId of justFinished) {
      // Find the element on screen — prefer larger card over tab button
      const all = document.querySelectorAll(`[data-desk-id="${deskId}"]`);
      let bestRect: DOMRect | undefined;
      let bestArea = 0;
      all.forEach((node) => {
        const r = node.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > bestArea) { bestArea = area; bestRect = r; }
      });
      const rect = bestRect;
      const originX = rect
        ? (rect.left + rect.width / 2) / window.innerWidth
        : 0.5;
      const originY = rect
        ? (rect.top + rect.height / 3) / window.innerHeight
        : 0.7;
      void confetti({
        particleCount: 60,
        spread: 55,
        origin: { x: originX, y: originY },
        colors: ["#22d3ee", "#a78bfa", "#34d399", "#fbbf24", "#f472b6"],
        disableForReducedMotion: true,
      });
    }
  }, [rosterEntries]);

  // Map of deskId → count of active child runs this agent delegated.
  // Drives satellite dots around the delegator's sprite.
  const delegationsByDesk = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of rosterEntries ?? []) {
      const n = e.activeDelegations ?? 0;
      if (n > 0) m.set(e.agent.deskId, n);
    }
    return m;
  }, [rosterEntries]);

  // Beam lines: active delegation pairs as {fromDeskId, toDeskId}.
  // Build a deskId lookup from agentId first.
  const delegationLinks = useMemo(() => {
    const agentToDeskId = new Map<string, string>();
    for (const e of rosterEntries ?? []) agentToDeskId.set(e.agent.id, e.agent.deskId);
    const links: { fromDeskId: string; toDeskId: string }[] = [];
    for (const e of rosterEntries ?? []) {
      const delegatorAgentId = (e as { delegatedByAgentId?: string | null }).delegatedByAgentId;
      if (!delegatorAgentId) continue;
      const fromDeskId = agentToDeskId.get(delegatorAgentId);
      if (fromDeskId) links.push({ fromDeskId, toDeskId: e.agent.deskId });
    }
    return links;
  }, [rosterEntries]);

  // Map delegator agentId → names of agents they're currently delegating to.
  const delegateeNamesByAgent = useMemo(() => {
    const nameMap = new Map<string, string>();
    for (const e of rosterEntries ?? []) nameMap.set(e.agent.id, e.agent.name);
    const m = new Map<string, string[]>();
    for (const e of rosterEntries ?? []) {
      const delegatorId = (e as { delegatedByAgentId?: string | null }).delegatedByAgentId;
      if (!delegatorId) continue;
      const names = m.get(delegatorId) ?? [];
      names.push(e.agent.name);
      m.set(delegatorId, names);
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
      } else if ((status === "running" || status === "starting") && (e.activeDelegations ?? 0) > 0) {
        m.set(e.agent.deskId, "delegating");
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
      { id: string; isReal: boolean; officeSlug: string }
    >();
    for (const slug of order) {
      for (const a of (offices[slug]?.agents ?? [])) {
        m.set(a.deskId, { id: a.id, isReal: a.isReal, officeSlug: slug });
      }
    }
    return m;
  }, [offices, order]);

  const runByDesk = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const e of rosterEntries ?? []) {
      m.set(e.agent.deskId, e.current?.runId ?? null);
    }
    return m;
  }, [rosterEntries]);

  // All agents for the quick view (heads + pinnable)
  const allQuickViewAgents = useMemo(() => {
    const agents: Array<{
      id: string; deskId: string; name: string; role: string;
      officeSlug: string; officeName: string; accent: string;
      premade: string | null; status: string | null;
      activeDelegations: number; teamSize: number; isHead: boolean;
      isDeptHead: boolean;
    }> = [];
    for (const slug of order) {
      const office = offices[slug];
      if (!office) continue;
      const stationModule = station.modules.find((m) => m.office === slug);
      const teamSize = office.agents.filter((a) => a.isReal).length;
      for (const a of office.agents) {
        if (!a.isReal) continue;
        const entry = rosterEntries?.find((e) => e.agent.id === a.id);
        agents.push({
          id: a.id,
          deskId: a.deskId,
          name: a.name,
          role: a.role,
          officeSlug: slug,
          officeName: office.name,
          accent: stationModule?.accent ?? office.theme.accent,
          premade: a.visual?.premade ?? null,
          status: entry?.current?.runStatus ?? null,
          activeDelegations: entry?.activeDelegations ?? 0,
          teamSize,
          isHead: a.isHead ?? false,
          isDeptHead: a.isDeptHead ?? false,
        });
      }
    }
    return agents;
  }, [rosterEntries]);

  const headAgents = useMemo(
    () => allQuickViewAgents.filter((a) => a.isHead),
    [allQuickViewAgents],
  );

  // Pinned agent IDs for quick view (persisted to localStorage)
  const [quickViewPins, setQuickViewPins] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      return JSON.parse(localStorage.getItem("ri-quickview-pins") ?? "[]");
    } catch { return []; }
  });
  // Hidden agent IDs — allows removing heads from quick view
  const [quickViewHidden, setQuickViewHidden] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      return JSON.parse(localStorage.getItem("ri-quickview-hidden") ?? "[]");
    } catch { return []; }
  });
  const pinAgent = (id: string) => {
    // Add to pins + unhide if previously hidden
    setQuickViewPins((prev) => {
      const next = prev.includes(id) ? prev : [...prev, id];
      localStorage.setItem("ri-quickview-pins", JSON.stringify(next));
      return next;
    });
    setQuickViewHidden((prev) => {
      const next = prev.filter((h) => h !== id);
      localStorage.setItem("ri-quickview-hidden", JSON.stringify(next));
      return next;
    });
  };
  const unpinAgent = (id: string) => {
    // Remove from pins + add to hidden (so heads stay gone)
    setQuickViewPins((prev) => {
      const next = prev.filter((p) => p !== id);
      localStorage.setItem("ri-quickview-pins", JSON.stringify(next));
      return next;
    });
    setQuickViewHidden((prev) => {
      const next = prev.includes(id) ? prev : [...prev, id];
      localStorage.setItem("ri-quickview-hidden", JSON.stringify(next));
      return next;
    });
  };

  const handleAgentClick = useCallback(
    (
      officeSlug: string,
      deskId: string,
      clientX: number,
      clientY: number,
      shiftKey?: boolean,
    ) => {
      const slug = officeSlug as string;
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
      const slug = officeSlug as string;
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

  const handleModuleMove = useCallback(
    async (officeSlug: string, offsetX: number, offsetY: number) => {
      try {
        const res = await fetch("/api/modules/move", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ officeSlug, offsetX, offsetY }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          console.error("module move failed:", err.error ?? res.status);
        }
      } catch (e) {
        console.error("module move network error:", e);
      }
    },
    [],
  );

  const officeContainerRef = useRef<HTMLDivElement | null>(null);
  const sidebarOffice = offices[sidebarSlug] ?? offices[order[0]];

  const allAgentsWithSlug = useMemo(() => {
    return order.flatMap((slug) =>
      (offices[slug]?.agents ?? []).map((a) => ({ ...a, officeSlug: slug })),
    );
  }, [offices, order]);

  const allAgentsForDock = useMemo(() => {
    return allAgentsWithSlug.map((a) => ({
      id: a.id,
      name: a.name,
      role: a.role,
      deskId: a.deskId,
      isReal: a.isReal,
      officeSlug: a.officeSlug,
      model: a.model ?? null,
      isHead: a.isHead ?? false,
      isDeptHead: a.isDeptHead ?? false,
    }));
  }, [allAgentsWithSlug]);

  // Lookup maps for ActiveGroupchats + NotificationCenter
  const agentNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const slug of order) {
      for (const a of (offices[slug]?.agents ?? [])) m.set(a.id, a.name);
    }
    return m;
  }, [offices, order]);
  const officeNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const slug of order) {
      if (offices[slug]) m.set(slug, (offices[slug]?.name ?? slug));
    }
    return m;
  }, [offices, order]);
  const officeAccentMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const slug of order) {
      if (offices[slug]) m.set(slug, (offices[slug]?.theme ?? { accent: "#5aa0ff" }).accent);
    }
    return m;
  }, [offices, order]);

  // Loading state while offices are being fetched
  if (!officesLoaded || order.length === 0) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-black text-white">
        <div className="font-mono text-xs text-white/30">loading workspaces...</div>
      </div>
    );
  }

  const sidebarOfficeSlug = sidebarSlug || order[0];

  return (
    <div className="flex h-screen w-screen flex-col bg-black text-white">
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-2 text-sm">
        <div className="font-mono tracking-tight">robots-in-a-house</div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <Tooltip label="Previous office" position="bottom">
              <button
                onClick={() => {
                  const idx = focusedModule ? order.indexOf(focusedModule) : 0;
                  focusModule(order[(idx - 1 + order.length) % order.length]);
                }}
                className="rounded px-1.5 py-0.5 font-mono text-xs opacity-50 transition hover:bg-white/10 hover:opacity-100"
              >
                ‹
              </button>
            </Tooltip>
            <div className="font-mono text-xs opacity-60">
              station: {station.name}
              {focusedModule ? ` · ${offices[focusedModule].name}` : " · overview"}
            </div>
            <Tooltip label="Next office" position="bottom">
              <button
                onClick={() => {
                  const idx = focusedModule ? order.indexOf(focusedModule) : -1;
                  focusModule(order[(idx + 1) % order.length]);
                }}
                className="rounded px-1.5 py-0.5 font-mono text-xs opacity-50 transition hover:bg-white/10 hover:opacity-100"
              >
                ›
              </button>
            </Tooltip>
          </div>
        </div>
      </header>
      <HealthBanner />
      <div className={`flex flex-1 overflow-hidden ${viewMode === "grid" ? "flex-row" : "flex-col"}`}>
          {viewMode === "grid" ? (
            /* ── Grid view: side-by-side layout ── */
            <HeadsView
              heads={headAgents}
              pinnedIds={quickViewPins}
              hiddenIds={quickViewHidden}
              allAgents={allQuickViewAgents}
              tabOrder={tabs.filter((t) => t.kind === "1:1" && t.agentId).map((t) => t.agentId!)}
              onChat={(agent) => {
                openOrFocus({
                  id: agent.id,
                  agentId: agent.id,
                  deskId: agent.deskId,
                  officeSlug: agent.officeSlug,
                  kind: "1:1",
                  label: agent.name,
                });
              }}
              onPin={pinAgent}
              onUnpin={unpinAgent}
              onReorder={(fromId, toId) => {
                reorder(fromId, toId);
              }}
              onSwitchView={() => {
                setViewMode("canvas");
                localStorage.setItem("ri-view-mode", "canvas");
              }}
              onSettings={() => setShowSettings((v) => !v)}
              onOpenGroupchat={(label, groupchatId) => openGroupchat(label, groupchatId)}
              onNewGroupchat={() => openGroupchat("New Groupchat")}
            />
          ) : (
          <>
          <main
            className="relative min-h-0 flex-1 overflow-hidden"
            ref={officeContainerRef}
          >
            {/* Toolbar — top-left (persists across views) */}
            <div className="pointer-events-auto absolute left-3 top-3 z-30 flex gap-2">
              <Tooltip label="Settings" position="bottom">
              <button
                type="button"
                onClick={() => setShowSettings((v) => !v)}
                className="flex h-9 w-9 items-center justify-center rounded-lg bg-gray-900/80 text-gray-300 shadow-lg backdrop-blur-sm transition-colors hover:bg-gray-800 hover:text-white"
              >
                <svg width="20" height="20" viewBox="0 0 16 16" shapeRendering="crispEdges">
                  <rect x="6" y="0" width="4" height="2" fill="currentColor" />
                  <rect x="6" y="14" width="4" height="2" fill="currentColor" />
                  <rect x="0" y="6" width="2" height="4" fill="currentColor" />
                  <rect x="14" y="6" width="2" height="4" fill="currentColor" />
                  <rect x="1" y="1" width="3" height="3" fill="currentColor" />
                  <rect x="12" y="1" width="3" height="3" fill="currentColor" />
                  <rect x="1" y="12" width="3" height="3" fill="currentColor" />
                  <rect x="12" y="12" width="3" height="3" fill="currentColor" />
                  <rect x="3" y="3" width="10" height="10" fill="currentColor" />
                  <rect x="5" y="5" width="6" height="6" fill="#1a1a2e" />
                </svg>
              </button>
              </Tooltip>
              <Tooltip label="Switch to grid view" position="bottom">
              <button
                type="button"
                onClick={() => {
                  setViewMode("grid");
                  localStorage.setItem("ri-view-mode", "grid");
                }}
                className="flex h-9 w-9 items-center justify-center rounded-lg bg-gray-900/80 text-gray-300 shadow-lg backdrop-blur-sm transition-colors hover:bg-gray-800 hover:text-white"
              >
                <svg width="20" height="20" viewBox="0 0 16 16" shapeRendering="crispEdges">
                  <rect x="1" y="1" width="14" height="14" fill="currentColor" />
                  <rect x="2" y="2" width="5" height="5" fill="#1a1a2e" />
                  <rect x="9" y="2" width="5" height="5" fill="#1a1a2e" />
                  <rect x="2" y="9" width="5" height="5" fill="#1a1a2e" />
                  <rect x="9" y="9" width="5" height="5" fill="#1a1a2e" />
                </svg>
              </button>
              </Tooltip>
            </div>
            {/* Tool buttons — top-right (persists across views) */}
            <div className="pointer-events-auto absolute right-3 top-3 z-30 flex gap-2">
              <Tooltip label="Workspace Builder" position="bottom">
              <a
                href="/workspace-builder"
                target="_blank"
                rel="noopener noreferrer"
                className="flex h-9 w-9 items-center justify-center rounded-lg bg-gray-900/80 text-gray-300 shadow-lg backdrop-blur-sm transition-colors hover:bg-gray-800 hover:text-white"
              >
                <svg width="20" height="20" viewBox="0 0 16 16" shapeRendering="crispEdges">
                  <rect x="7" y="1" width="2" height="1" fill="currentColor" />
                  <rect x="5" y="2" width="6" height="1" fill="currentColor" />
                  <rect x="3" y="3" width="10" height="1" fill="currentColor" />
                  <rect x="3" y="4" width="10" height="7" fill="currentColor" />
                  <rect x="7" y="8" width="2" height="3" fill="#1a1a2e" />
                  <rect x="4" y="5" width="2" height="2" fill="#facc15" />
                  <rect x="10" y="5" width="2" height="2" fill="#facc15" />
                  <rect x="10" y="0" width="2" height="3" fill="currentColor" />
                </svg>
              </a>
              </Tooltip>
              <Tooltip label="Sprite Maker" position="bottom">
              <a
                href="/sprite-maker"
                target="_blank"
                rel="noopener noreferrer"
                className="flex h-9 w-9 items-center justify-center rounded-lg bg-gray-900/80 text-gray-300 shadow-lg backdrop-blur-sm transition-colors hover:bg-gray-800 hover:text-white"
              >
                <svg width="20" height="20" viewBox="0 0 16 16" shapeRendering="crispEdges">
                  <rect x="5" y="1" width="4" height="4" fill="currentColor" rx="0" />
                  <rect x="6" y="5" width="2" height="3" fill="currentColor" />
                  <rect x="4" y="6" width="2" height="1" fill="currentColor" />
                  <rect x="8" y="6" width="2" height="1" fill="currentColor" />
                  <rect x="5" y="8" width="2" height="3" fill="currentColor" />
                  <rect x="7" y="8" width="2" height="3" fill="currentColor" />
                  <rect x="12" y="1" width="1" height="3" fill="#facc15" />
                  <rect x="11" y="2" width="3" height="1" fill="#facc15" />
                  <rect x="10" y="0" width="1" height="1" fill="#facc15" opacity="0.5" />
                  <rect x="14" y="0" width="1" height="1" fill="#facc15" opacity="0.5" />
                  <rect x="10" y="4" width="1" height="1" fill="#facc15" opacity="0.5" />
                  <rect x="14" y="4" width="1" height="1" fill="#facc15" opacity="0.5" />
                </svg>
              </a>
              </Tooltip>
            </div>
            {/* To-do list — top-left, below toolbar (canvas view only) */}
            {focusedModule && (
              <div className="pointer-events-auto absolute left-3 top-14 z-20 w-64">
                <OfficeTodos
                  officeSlug={focusedModule}
                  accent={offices[focusedModule]?.theme?.accent}
                />
              </div>
            )}
            <Station
              station={station}
              offices={offices}
              focusedModule={focusedModule}
              busyDeskIds={busyDeskIds}
              agentStatus={agentStatus}
              delegationsByDesk={delegationsByDesk}
              delegationLinks={delegationLinks}
              selectedDeskId={selectedDeskId}
              onDeskSelect={(deskId) => selectDesk(deskId)}
              onAgentClick={handleAgentClick}
              onDeskDrop={handleDeskDrop}
              onAgentMove={handleAgentMove}
              onModuleMove={handleModuleMove}
              onModuleFocus={(slug) => focusModule(slug as string)}
              onAgentHover={(officeSlug, deskId, clientX, clientY) => {
                setHoverCard({ deskId, officeSlug: officeSlug as string, x: clientX, y: clientY });
              }}
              onAgentHoverOut={() => setHoverCard(null)}
              onAgentPositions={(positions) => {
                agentPositionsRef.current = positions;
              }}
              contextUsage={contextUsage}
              showGrid={showGrid}
            />
            {/* Active groupchats — top-right overlay, below tool buttons */}
            <div className="pointer-events-auto absolute right-3 top-14 z-20 w-64">
              <ActiveGroupchats
                agentNames={agentNameMap}
                officeNames={officeNameMap}
                officeAccents={officeAccentMap}
                onOpen={(groupchatId) => {
                  openGroupchat("Groupchat", groupchatId);
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
              const agentEntry = (rosterEntries ?? []).find((e) => e.agent.id === line.agentId);
              const icon = agentEntry ? roleIcon(agentEntry.agent.role) : undefined;
              if (line.status === "thinking") {
                return (
                  <SpriteBubble
                    key={`ambient:${line.agentId}`}
                    mode="thinking"
                    x={pos.clientX}
                    y={pos.clientY}
                    containerRef={officeContainerRef}
                    onDismiss={() => {}} // auto-dismisses itself
                  />
                );
              }
              return (
                <SpriteBubble
                  key={`ambient:${line.agentId}`}
                  mode="ambient"
                  x={pos.clientX}
                  y={pos.clientY}
                  text={line.lastLine}
                  icon={icon}
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
                activeDelegations={rosterEntry?.activeDelegations ?? 0}
                delegateeNames={rosterEntry ? (delegateeNamesByAgent.get(rosterEntry.agent.id) ?? []) : []}
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
            activeOfficeSlug={sidebarSlug}
            onAckDesk={(deskId) => {
              const runId = runByDesk.get(deskId);
              if (runId) {
                void fetch(`/api/runs/${encodeURIComponent(runId)}/ack`, { method: "POST" })
                  .then(() => refetchRoster())
                  .catch(() => {});
              }
            }}
          />
          <WelcomePrompt
            headAgentName={sidebarOffice.agents.find((a) => a.isHead)?.name ?? sidebarOffice.agents[0]?.name ?? null}
            headAgentId={sidebarOffice.agents.find((a) => a.isHead)?.id ?? sidebarOffice.agents[0]?.id ?? null}
            officeSlug={sidebarSlug}
            onTryIt={async (agentId, slug, prompt) => {
              const agent = sidebarOffice.agents.find((a) => a.id === agentId);
              if (!agent) return;
              await fetch("/api/quick-run", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ officeSlug: slug, agentId, prompt }),
              }).catch(() => {});
              if (agent.isReal) selectDesk(agent.deskId);
              void refetchRoster();
            }}
          />
          <PromptBar
            agents={allAgentsWithSlug}
            onSent={({ deskId, isReal }) => {
              if (isReal) selectDesk(deskId);
              void refetchRoster();
            }}
          />
          </>
          )}

          {/* ── Grid view: dock as right-side panel ── */}
          {viewMode === "grid" && (
            <div className="flex h-full w-[380px] shrink-0 flex-col border-l border-white/10 bg-zinc-950">
              <ChatDock
                agents={allAgentsForDock}
                rosterEntries={rosterEntries ?? []}
                offices={offices}
                deskRunStatus={deskRunStatus}
                activeOfficeSlug={sidebarSlug}
                layout="side"
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
                agents={allAgentsWithSlug}
                onSent={({ deskId, isReal }) => {
                  if (isReal) selectDesk(deskId);
                  void refetchRoster();
                }}
              />
            </div>
          )}
      </div>
      <CommandPalette
        slug={sidebarSlug}
        allOffices={order.map((s) => ({ slug: s, name: offices[s]?.name ?? s, agents: offices[s]?.agents ?? [] }))}
        onSwitchOffice={(slug) => focusModule(slug as string)}
        onFocusAgent={(deskId) => selectDesk(deskId)}
      />
    </div>
  );
}
