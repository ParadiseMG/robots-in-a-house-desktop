"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import paradiseRaw from "@/config/paradise.office.json";
import dontcallRaw from "@/config/dontcall.office.json";
import stationRaw from "@/config/station.json";
import type {
  OfficeConfig,
  StationConfig,
  IndicatorKind,
} from "@/lib/office-types";
import Station from "@/components/pixi/Station";
import StationMinimap from "@/components/station/StationMinimap";
import type { Task } from "@/components/tray/TaskTray";
import RosterTray, { type RosterEntry } from "@/components/roster/RosterTray";
import AgentInspector from "@/components/inspector/AgentInspector";
import PromptBar from "@/components/prompt-bar/PromptBar";
import CommandPalette from "@/components/palette/CommandPalette";
import UsageTracker from "@/components/usage/UsageTracker";
import SpriteBubble from "@/components/sprite-bubble/SpriteBubble";
import MeetingModal from "@/components/war-room/MeetingModal";
import ChatDock, { DockTabsProvider } from "@/components/dock/ChatDock";

const offices: Record<string, OfficeConfig> = {
  paradise: paradiseRaw as OfficeConfig,
  dontcall: dontcallRaw as OfficeConfig,
};
const station = stationRaw as StationConfig;
const order = ["paradise", "dontcall"] as const;
type OfficeSlug = (typeof order)[number];

const ROSTER_POLL_MS = 5_000;

export default function Home() {
  // The office whose sidebar + roster data is shown. Always a real slug (never null).
  const [sidebarSlug, setSidebarSlug] = useState<OfficeSlug>("paradise");
  // Whether the Pixi camera is focused on a module or in overview.
  // null = overview (camera fits both modules), string = slug of focused module.
  const [focusedModule, setFocusedModule] = useState<OfficeSlug | null>(null);

  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedDeskId, setSelectedDeskId] = useState<string | null>(null);
  const [inspectorBump, setInspectorBump] = useState(0);
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
  const [meetingOpen, setMeetingOpen] = useState<{ officeSlug: OfficeSlug } | null>(null);

  // Restore sidebar slug + desk selection from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem("ri-office") as OfficeSlug | null;
    if (stored === "paradise" || stored === "dontcall") {
      setSidebarSlug(stored);
      const storedDesk = localStorage.getItem(`ri-desk-${stored}`);
      if (storedDesk) setSelectedDeskId(storedDesk);
    }
    const storedFocus = localStorage.getItem(
      "ri-focus",
    ) as OfficeSlug | "overview" | null;
    if (storedFocus === "paradise" || storedFocus === "dontcall") {
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
      const res = await fetch(
        `/api/roster?office=${encodeURIComponent(sidebarSlug)}`,
        { cache: "no-store" },
      );
      if (!res.ok) return;
      const json = (await res.json()) as { entries: RosterEntry[] };
      setRosterEntries(json.entries);
    } catch {
      // ignore
    }
  }, [sidebarSlug]);

  useEffect(() => {
    setRosterEntries(null);
    let cancelled = false;
    void (async () => {
      await refetchRoster();
      if (cancelled) return;
    })();
    const id = setInterval(refetchRoster, ROSTER_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sidebarSlug, refetchRoster, inspectorBump]);

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
    ) => {
      const slug = officeSlug as OfficeSlug;
      // If clicking an agent in a different office than the current sidebar,
      // switch sidebar context first so the inspector/roster query the right server.
      if (slug !== sidebarSlug) {
        setSidebarSlug(slug);
        localStorage.setItem("ri-office", slug);
      }
      const kind = agentStatus.get(deskId);
      if (kind === "awaiting_input") {
        selectDesk(deskId, slug);
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
      if (kind === "done_unacked") {
        selectDesk(deskId, slug);
        setBubble(null);
        return;
      }
      const agent = agentByDesk.get(deskId);
      if (!agent) return;
      selectDesk(deskId, slug);
      setBubble({
        deskId,
        officeSlug: slug,
        x: clientX,
        y: clientY,
        mode: "task",
      });
    },
    [agentStatus, agentByDesk, runByDesk, selectDesk, sidebarSlug],
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
      if (selectedDeskId === deskId) {
        setInspectorBump((n) => n + 1);
      }
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
        if (selectedDeskId === bubble.deskId)
          setInspectorBump((n) => n + 1);
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
        if (selectedDeskId === bubble.deskId)
          setInspectorBump((n) => n + 1);
      }
    },
    [bubble, agentByDesk, selectedDeskId, selectDesk, refetchRoster],
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

  return (
    <DockTabsProvider>
    <div className="flex h-screen w-screen flex-col bg-black text-white">
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-2 text-sm">
        <div className="font-mono tracking-tight">robots-in-a-house</div>
        <div className="flex items-center gap-3">
          <div className="font-mono text-xs opacity-60">
            station: {station.name}
            {focusedModule ? ` · ${offices[focusedModule].name}` : " · overview"}
          </div>
        </div>
      </header>
      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-1 flex-col overflow-hidden">
          <main
            className="relative flex-1 overflow-hidden"
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
                if (slug === "paradise" || slug === "dontcall") {
                  setMeetingOpen({ officeSlug: slug });
                }
              }}
              showGrid={showGrid}
            />
            <StationMinimap
              station={station}
              offices={offices}
              focusedModule={focusedModule}
              onFocusModule={focusModule}
            />
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
          </main>
          <UsageTracker />
          <ChatDock
            agents={allAgentsForDock}
            rosterEntries={rosterEntries ?? []}
          />
          <PromptBar
            agents={sidebarOffice.agents}
            officeSlug={sidebarSlug}
            onSent={({ deskId, isReal }) => {
              if (isReal) selectDesk(deskId);
              void refetchRoster();
              if (selectedDeskId === deskId)
                setInspectorBump((n) => n + 1);
            }}
          />
        </div>
        {selectedDeskId ? (
          <AgentInspector
            key={`${sidebarSlug}:${selectedDeskId}:${inspectorBump}`}
            officeSlug={sidebarSlug}
            deskId={selectedDeskId}
            onClose={() => selectDesk(null)}
          />
        ) : (
          <RosterTray
            officeSlug={sidebarSlug}
            entries={rosterEntries}
            onSelect={(deskId) => selectDesk(deskId)}
            onConveneWarRoom={() => setMeetingOpen({ officeSlug: sidebarSlug })}
            warRoomAccent={offices[sidebarSlug].theme.accent}
          />
        )}
      </div>
      {meetingOpen && (
        <MeetingModal
          office={offices[meetingOpen.officeSlug]}
          roster={meetingOpen.officeSlug === sidebarSlug ? rosterEntries : null}
          onClose={() => setMeetingOpen(null)}
          onConvened={() => {
            void refetchRoster();
          }}
          onOpenInspector={(deskId) => {
            const slug = meetingOpen.officeSlug;
            setMeetingOpen(null);
            focusModule(slug);
            selectDesk(deskId, slug);
          }}
        />
      )}
      <CommandPalette
        slug={sidebarSlug}
        otherSlug={sidebarSlug === "paradise" ? "dontcall" : "paradise"}
        otherName={
          offices[sidebarSlug === "paradise" ? "dontcall" : "paradise"].name
        }
        agents={sidebarOffice.agents}
        onSwitchOffice={() =>
          focusModule(sidebarSlug === "paradise" ? "dontcall" : "paradise")
        }
        onFocusAgent={(deskId) => selectDesk(deskId)}
      />
    </div>
    </DockTabsProvider>
  );
}
