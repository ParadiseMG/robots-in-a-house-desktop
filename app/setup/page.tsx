"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OfficeConfig, AgentConfig, DeskConfig } from "@/lib/office-types";

// ── Constants ───────────────────────────────────────────────────────────────

const MODELS = [
  { id: "claude-sonnet-4-20250514", label: "Sonnet", desc: "Fast builder" },
  { id: "claude-opus-4-6", label: "Opus", desc: "Deep thinker" },
];

const SPRITE_TILE = 16;
const SPRITE_CHAR_W = 16;
const SPRITE_CHAR_H = 32;
const SPRITE_IDLE_Y = 32;
const SPRITE_S_COL = 18;

const SUGGESTED_TEAMS: {
  label: string;
  desc: string;
  agents: { name: string; role: string; model: string; isHead?: boolean }[];
}[] = [
  {
    label: "Startup",
    desc: "A small product team",
    agents: [
      { name: "Lead", role: "Director", model: "claude-opus-4-6", isHead: true },
      { name: "Builder", role: "Engineer", model: "claude-sonnet-4-20250514" },
      { name: "Designer", role: "Designer", model: "claude-sonnet-4-20250514" },
    ],
  },
  {
    label: "Agency",
    desc: "Creative + ops split",
    agents: [
      { name: "Director", role: "Creative Director", model: "claude-opus-4-6", isHead: true },
      { name: "Writer", role: "Copywriter", model: "claude-sonnet-4-20250514" },
      { name: "Dev", role: "Developer", model: "claude-sonnet-4-20250514" },
      { name: "Ops", role: "Operations", model: "claude-sonnet-4-20250514" },
    ],
  },
  {
    label: "Solo",
    desc: "Just you and a right-hand",
    agents: [
      { name: "Chief", role: "Director", model: "claude-opus-4-6", isHead: true },
      { name: "Doer", role: "Generalist", model: "claude-sonnet-4-20250514" },
    ],
  },
  {
    label: "Custom",
    desc: "Start blank, add your own",
    agents: [],
  },
];

type Step = "welcome" | "name" | "room" | "team" | "agents" | "memory" | "review" | "done";
const STEPS: Step[] = ["welcome", "name", "room", "team", "agents", "memory", "review", "done"];

type ClaudeMemoryFile = {
  name: string;
  path: string;
  content: string;
  source: "global" | "project";
  project?: string;
};

type ClaudeMemoryProject = {
  slug: string;
  label: string;
  files: ClaudeMemoryFile[];
};

// ── Image helpers ───────────────────────────────────────────────────────────

const imgCache = new Map<string, HTMLImageElement>();

function loadImg(src: string): Promise<HTMLImageElement> {
  const c = imgCache.get(src);
  if (c) return Promise.resolve(c);
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { imgCache.set(src, img); res(img); };
    img.onerror = rej;
    img.src = src;
  });
}

function SpriteMini({ file, size = 32 }: { file: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let dead = false;
    loadImg(`/sprites/characters/${file}`).then((img) => {
      if (dead || !ref.current) return;
      const ctx = ref.current.getContext("2d");
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, size, size * 2);
      ctx.drawImage(img, SPRITE_S_COL * SPRITE_TILE, SPRITE_IDLE_Y, SPRITE_CHAR_W, SPRITE_CHAR_H, 0, 0, size, size * 2);
    }).catch(() => {});
    return () => { dead = true; };
  }, [file, size]);
  return <canvas ref={ref} width={size} height={size * 2} style={{ imageRendering: "pixelated", width: size, height: size * 2 }} />;
}

// ── Room preview ────────────────────────────────────────────────────────────

function RoomPreview({ layerFile, selected, onClick }: { layerFile: string; selected: boolean; onClick: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let dead = false;
    loadImg(`/sprites/interiors/premade_rooms/${layerFile}`).then((img) => {
      if (dead || !ref.current) return;
      const ctx = ref.current.getContext("2d");
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      const scale = Math.min(160 / img.width, 120 / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ref.current.width = 160;
      ref.current.height = 120;
      ctx.fillStyle = "#0a0a0a";
      ctx.fillRect(0, 0, 160, 120);
      ctx.drawImage(img, (160 - w) / 2, (120 - h) / 2, w, h);
    }).catch(() => {});
    return () => { dead = true; };
  }, [layerFile]);

  const label = layerFile.replace(/_layer1\.png$/, "").replace(/_/g, " ");
  return (
    <button onClick={onClick} className={`group flex flex-col items-center gap-1.5 transition-all`}>
      <div className={`rounded-lg overflow-hidden border-2 transition-all ${
        selected ? "border-blue-400 shadow-lg shadow-blue-400/20" : "border-white/10 group-hover:border-white/25"
      }`}>
        <canvas ref={ref} width={160} height={120} style={{ imageRendering: "pixelated", width: 160, height: 120 }} />
      </div>
      <span className={`text-[10px] transition-colors ${selected ? "text-blue-400" : "text-white/40 group-hover:text-white/60"}`}>
        {label}
      </span>
    </button>
  );
}

// ── Agent row editor (simplified) ───────────────────────────────────────────

function AgentRow({
  agent,
  sprites,
  onUpdate,
  onRemove,
}: {
  agent: AgentConfig;
  sprites: string[];
  onUpdate: (patch: Partial<AgentConfig>) => void;
  onRemove: () => void;
}) {
  const [showSprites, setShowSprites] = useState(false);
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
      <div className="flex items-center gap-3">
        <button onClick={() => setShowSprites(!showSprites)} className="flex-shrink-0 rounded-md p-1 hover:bg-white/5 transition-colors" title="Change sprite">
          {agent.visual?.premade ? <SpriteMini file={agent.visual.premade} size={16} /> : (
            <div className="w-4 h-8 rounded bg-white/10" />
          )}
        </button>
        <div className="flex-1 grid grid-cols-2 gap-2">
          <input
            value={agent.name}
            onChange={(e) => onUpdate({ name: e.target.value })}
            placeholder="Name"
            className="rounded-md border border-white/10 bg-transparent px-2 py-1.5 text-xs text-white outline-none focus:border-blue-400/40"
          />
          <input
            value={agent.role}
            onChange={(e) => onUpdate({ role: e.target.value })}
            placeholder="Role"
            className="rounded-md border border-white/10 bg-transparent px-2 py-1.5 text-xs text-white/60 outline-none focus:border-blue-400/40"
          />
        </div>
        <select
          value={agent.model || MODELS[0].id}
          onChange={(e) => onUpdate({ model: e.target.value })}
          className="rounded-md border border-white/10 bg-transparent px-2 py-1.5 text-[10px] text-white/50 outline-none"
        >
          {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        <label className="flex items-center gap-1 text-[9px] text-white/30" title="Head agent (planner)">
          <input type="checkbox" checked={!!agent.isHead} onChange={(e) => onUpdate({ isHead: e.target.checked })} className="accent-blue-400" />
          Head
        </label>
        <button onClick={onRemove} className="text-[10px] text-white/20 hover:text-red-400 transition-colors">x</button>
      </div>
      {showSprites && (
        <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1 pt-1 border-t border-white/5">
          {sprites.map((s) => (
            <button
              key={s}
              onClick={() => { onUpdate({ visual: { premade: s } }); setShowSprites(false); }}
              className={`flex-shrink-0 rounded p-0.5 transition-all ${
                agent.visual?.premade === s ? "ring-2 ring-blue-400 bg-gray-800" : "hover:bg-gray-800"
              }`}
            >
              <SpriteMini file={s} size={14} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Progress bar ────────────────────────────────────────────────────────────

function ProgressBar({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex gap-1.5">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`h-1 flex-1 rounded-full transition-all duration-300 ${
            i < current ? "bg-blue-400" : i === current ? "bg-blue-400/50" : "bg-white/10"
          }`}
        />
      ))}
    </div>
  );
}

// ── Main wizard ─────────────────────────────────────────────────────────────

export default function SetupWizard() {
  const [step, setStep] = useState<Step>("welcome");
  const [officeName, setOfficeName] = useState("");
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const [selectedTeam, setSelectedTeam] = useState<number | null>(null);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [sprites, setSprites] = useState<string[]>([]);
  const [rooms, setRooms] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fadeIn, setFadeIn] = useState(true);

  // Claude memory import
  const [claudeMemory, setClaudeMemory] = useState<{
    found: boolean;
    global: ClaudeMemoryFile | null;
    projects: ClaudeMemoryProject[];
  } | null>(null);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [selectedMemory, setSelectedMemory] = useState<Set<string>>(new Set());
  const [expandedProject, setExpandedProject] = useState<string | null>(null);

  // Load available sprites and rooms
  useEffect(() => {
    fetch("/api/workspace-builder/sprites")
      .then((r) => r.json())
      .then((d) => setSprites(d.sprites || []))
      .catch(() => {});
    fetch("/api/workspace-builder/rooms")
      .then((r) => r.json())
      .then((d) => {
        const all: string[] = [];
        for (const files of Object.values(d.grouped || {})) {
          for (const f of files as string[]) {
            if (f.includes("layer1")) all.push(f);
          }
        }
        setRooms(all);
        if (all.length > 0 && !selectedRoom) setSelectedRoom(all[0]);
      })
      .catch(() => {});
  }, []);

  const stepIndex = STEPS.indexOf(step);

  const transition = useCallback((next: Step) => {
    setFadeIn(false);
    setTimeout(() => {
      setStep(next);
      setFadeIn(true);
    }, 150);
  }, []);

  const next = useCallback(() => {
    const i = STEPS.indexOf(step);
    if (i < STEPS.length - 1) transition(STEPS[i + 1]);
  }, [step, transition]);

  const back = useCallback(() => {
    const i = STEPS.indexOf(step);
    if (i > 0) transition(STEPS[i - 1]);
  }, [step, transition]);

  // Fetch Claude memory when entering that step
  useEffect(() => {
    if (step !== "memory" || claudeMemory !== null) return;
    setMemoryLoading(true);
    fetch("/api/claude-memory")
      .then((r) => r.json())
      .then((data) => {
        setClaudeMemory(data);
        // Auto-select global CLAUDE.md if it exists
        if (data.global) {
          setSelectedMemory((prev) => new Set([...prev, data.global.path]));
        }
      })
      .catch(() => setClaudeMemory({ found: false, global: null, projects: [] }))
      .finally(() => setMemoryLoading(false));
  }, [step, claudeMemory]);

  // Build the imported memory content string from selections
  const buildImportedMemory = useCallback(() => {
    if (!claudeMemory) return "";
    const parts: string[] = [];

    if (claudeMemory.global && selectedMemory.has(claudeMemory.global.path)) {
      parts.push("## Imported from global Claude memory\n\n" + claudeMemory.global.content);
    }

    for (const project of claudeMemory.projects) {
      const selected = project.files.filter((f) => selectedMemory.has(f.path));
      if (selected.length === 0) continue;
      parts.push(
        `## Imported from: ${project.label}\n\n` +
          selected.map((f) => f.content).join("\n\n---\n\n"),
      );
    }

    return parts.join("\n\n---\n\n");
  }, [claudeMemory, selectedMemory]);

  // Assign sprites to agents that don't have one
  const assignSprites = useCallback((agentList: AgentConfig[]) => {
    const used = new Set(agentList.map((a) => a.visual?.premade).filter(Boolean));
    return agentList.map((a) => {
      if (a.visual?.premade) return a;
      const available = sprites.filter((s) => !used.has(s));
      const pick = available[0] || sprites[Math.floor(Math.random() * sprites.length)];
      if (pick) used.add(pick);
      return { ...a, visual: { premade: pick || "premade_02.png" } };
    });
  }, [sprites]);

  // When team template is selected
  const selectTeam = useCallback((index: number) => {
    setSelectedTeam(index);
    const template = SUGGESTED_TEAMS[index];
    const newAgents = assignSprites(
      template.agents.map((t, i) => ({
        id: t.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        deskId: `desk-${t.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        name: t.name,
        role: t.role,
        spritePack: "limezu/office/auto",
        visual: { premade: "" },
        isReal: true,
        model: t.model,
        isHead: t.isHead,
        allowedTools: ["Read", "Write", "Edit", "Grep", "Glob", "Bash", "WebSearch", "WebFetch"],
      }))
    );
    setAgents(newAgents);
  }, [assignSprites]);

  const updateAgent = useCallback((index: number, patch: Partial<AgentConfig>) => {
    setAgents((prev) => prev.map((a, i) => i === index ? { ...a, ...patch } : a));
  }, []);

  const removeAgent = useCallback((index: number) => {
    setAgents((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const addAgent = useCallback(() => {
    const id = `agent-${Date.now()}`;
    const available = sprites.filter((s) => !agents.some((a) => a.visual?.premade === s));
    const sprite = available[0] || sprites[0] || "premade_02.png";
    setAgents((prev) => [
      ...prev,
      {
        id,
        deskId: `desk-${id}`,
        name: "",
        role: "",
        spritePack: "limezu/office/auto",
        visual: { premade: sprite },
        isReal: true,
        model: MODELS[0].id,
        allowedTools: ["Read", "Write", "Edit", "Grep", "Glob", "Bash", "WebSearch", "WebFetch"],
      },
    ]);
  }, [sprites, agents]);

  // Build and save the office config
  const createWorkspace = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      // Load room dimensions
      let pixelWidth = 384;
      let pixelHeight = 256;
      if (selectedRoom) {
        try {
          const img = await loadImg(`/sprites/interiors/premade_rooms/${selectedRoom}`);
          pixelWidth = img.width;
          pixelHeight = img.height;
        } catch { /* use defaults */ }
      }

      const slug = officeName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "my-office";
      const cols = Math.ceil(pixelWidth / 16);
      const rows = Math.ceil(pixelHeight / 16);

      // Assign grid positions spiraling from center
      const cx = Math.floor(cols / 2);
      const cy = Math.floor(rows / 2);
      const taken = new Set<string>();
      const placedAgents: AgentConfig[] = [];
      const placedDesks: DeskConfig[] = [];

      for (const agent of agents) {
        const agentId = agent.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || agent.id;
        const deskId = `desk-${agentId}`;

        // Spiral outward from center
        let placed = false;
        for (let r = 0; r <= Math.max(cols, rows) && !placed; r++) {
          for (let dy = -r; dy <= r && !placed; dy++) {
            for (let dx = -r; dx <= r && !placed; dx++) {
              if (r > 0 && Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
              const x = cx + dx;
              const y = cy + dy;
              if (x < 1 || y < 1 || x >= cols - 1 || y >= rows - 1) continue;
              const key = `${x},${y}`;
              if (taken.has(key)) continue;
              taken.add(key);
              placedDesks.push({ id: deskId, roomId: "main", gridX: x, gridY: y, facing: "S" });
              placedAgents.push({
                ...agent,
                id: agentId,
                deskId,
                cwd: `agent-workspaces/${slug}/${agentId}`,
              });
              placed = true;
            }
          }
        }
      }

      const config: OfficeConfig = {
        slug,
        name: officeName.trim() || "My Office",
        theme: {
          floor: "#303034",
          floorAlt: "#3c3c42",
          wall: "#18181c",
          deskTop: "#4a4a50",
          deskSide: "#303034",
          accent: "#5aa0ff",
          highlight: "#88bbff",
          bg: "#1a2030",
          ...(selectedRoom ? {
            premadeRoom: {
              layers: [selectedRoom],
              pixelWidth,
              pixelHeight,
              sourceTileSize: 16,
              characterDepthIndex: 1,
            },
          } : {}),
        },
        tile: { w: 48, h: 48 },
        grid: { cols, rows },
        rooms: [{ id: "main", name: "Main", gridX: 1, gridY: 1, w: Math.min(8, cols - 2), h: Math.min(6, rows - 2) }],
        desks: placedDesks,
        agents: placedAgents,
      };

      const importedMemory = buildImportedMemory();

      const res = await fetch("/api/workspace-builder/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, config, importedMemory: importedMemory || undefined }),
      });
      if (!res.ok) throw new Error(await res.text());

      transition("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [officeName, selectedRoom, agents, transition, buildImportedMemory]);

  const slug = officeName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#0a0a0a] font-mono text-white p-6">
      <div className={`w-full max-w-2xl transition-all duration-150 ${fadeIn ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"}`}>

        {/* ── WELCOME ──────────────────────────────────────────────── */}
        {step === "welcome" && (
          <div className="flex flex-col items-center text-center gap-8">
            {/* Logo */}
            <div className="relative">
              <svg width="64" height="64" viewBox="0 0 64 64" shapeRendering="crispEdges" className="text-blue-400">
                <rect x="16" y="8" width="32" height="28" rx="4" fill="none" stroke="currentColor" strokeWidth="2" />
                <rect x="24" y="18" width="6" height="6" rx="1" fill="currentColor" />
                <rect x="34" y="18" width="6" height="6" rx="1" fill="currentColor" />
                <rect x="26" y="28" width="12" height="2" rx="1" fill="currentColor" opacity="0.5" />
                <rect x="20" y="38" width="8" height="12" fill="none" stroke="currentColor" strokeWidth="2" />
                <rect x="36" y="38" width="8" height="12" fill="none" stroke="currentColor" strokeWidth="2" />
                <rect x="28" y="36" width="8" height="4" fill="currentColor" opacity="0.3" />
                <circle cx="12" cy="12" r="2" fill="currentColor" opacity="0.3" />
                <circle cx="52" cy="20" r="1.5" fill="currentColor" opacity="0.2" />
                <circle cx="8" cy="40" r="1" fill="currentColor" opacity="0.15" />
              </svg>
            </div>

            <div>
              <h1 className="text-2xl font-bold tracking-tight mb-3">Robots in a House</h1>
              <p className="text-sm text-white/50 max-w-md leading-relaxed">
                A visual workspace where AI agents live, work, and collaborate.
                Each agent has a desk, a role, and the tools to do real work.
              </p>
            </div>

            <div className="grid grid-cols-3 gap-4 w-full max-w-lg">
              <FeatureCard
                title="Visual offices"
                desc="Pixel-art rooms where your agents sit. See who's working, who's idle, who needs you."
              />
              <FeatureCard
                title="Real work"
                desc="Agents read code, write files, search the web, and talk to each other. Not toys."
              />
              <FeatureCard
                title="Your team"
                desc="Assign roles, pick models, set permissions. Opus plans, Sonnet builds."
              />
            </div>

            <button
              onClick={next}
              className="rounded-lg bg-blue-500 px-8 py-3 text-sm font-bold text-white hover:bg-blue-400 transition-colors"
            >
              Set up your first workspace
            </button>

            <a href="/" className="text-[11px] text-white/20 hover:text-white/40 transition-colors">
              skip — I already have workspaces
            </a>
          </div>
        )}

        {/* ── NAME ─────────────────────────────────────────────────── */}
        {step === "name" && (
          <div className="flex flex-col gap-6">
            <ProgressBar current={0} total={5} />
            <div>
              <h2 className="text-lg font-bold mb-1">Name your workspace</h2>
              <p className="text-xs text-white/40">This is your brand, team, or project name. You can change it later.</p>
            </div>
            <input
              autoFocus
              value={officeName}
              onChange={(e) => setOfficeName(e.target.value)}
              placeholder="e.g. Acme Labs, My Startup, Side Project"
              className="w-full rounded-lg border border-white/15 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none focus:border-blue-400/50 placeholder:text-white/20"
              onKeyDown={(e) => { if (e.key === "Enter" && officeName.trim()) next(); }}
            />
            {slug && (
              <div className="text-[10px] text-white/20">
                slug: <span className="text-white/40">{slug}</span>
              </div>
            )}
            <div className="flex justify-between">
              <button onClick={back} className="text-xs text-white/30 hover:text-white/60 transition-colors">Back</button>
              <button
                onClick={next}
                disabled={!officeName.trim()}
                className="rounded-lg bg-blue-500 px-6 py-2 text-xs font-bold text-white hover:bg-blue-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        )}

        {/* ── ROOM ─────────────────────────────────────────────────── */}
        {step === "room" && (
          <div className="flex flex-col gap-6">
            <ProgressBar current={1} total={5} />
            <div>
              <h2 className="text-lg font-bold mb-1">Pick a room</h2>
              <p className="text-xs text-white/40">Choose the environment your agents will work in. This is cosmetic — you can swap it anytime.</p>
            </div>
            <div className="grid grid-cols-3 gap-3 max-h-[400px] overflow-y-auto pr-1">
              {rooms.map((r) => (
                <RoomPreview
                  key={r}
                  layerFile={r}
                  selected={selectedRoom === r}
                  onClick={() => setSelectedRoom(r)}
                />
              ))}
            </div>
            <div className="flex justify-between">
              <button onClick={back} className="text-xs text-white/30 hover:text-white/60 transition-colors">Back</button>
              <button
                onClick={next}
                className="rounded-lg bg-blue-500 px-6 py-2 text-xs font-bold text-white hover:bg-blue-400 transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        )}

        {/* ── TEAM TEMPLATE ────────────────────────────────────────── */}
        {step === "team" && (
          <div className="flex flex-col gap-6">
            <ProgressBar current={2} total={5} />
            <div>
              <h2 className="text-lg font-bold mb-1">Choose a team shape</h2>
              <p className="text-xs text-white/40">
                Pick a starting template. You can add, remove, or rename agents in the next step.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {SUGGESTED_TEAMS.map((t, i) => (
                <button
                  key={t.label}
                  onClick={() => selectTeam(i)}
                  className={`rounded-lg border p-4 text-left transition-all ${
                    selectedTeam === i
                      ? "border-blue-400 bg-blue-400/5"
                      : "border-white/10 hover:border-white/20 bg-white/[0.02]"
                  }`}
                >
                  <div className="text-sm font-bold mb-0.5">{t.label}</div>
                  <div className="text-[10px] text-white/40 mb-2">{t.desc}</div>
                  {t.agents.length > 0 ? (
                    <div className="flex flex-col gap-0.5">
                      {t.agents.map((a) => (
                        <div key={a.name} className="flex items-center gap-2 text-[10px]">
                          <span className={`w-1.5 h-1.5 rounded-full ${a.model.includes("opus") ? "bg-purple-400" : "bg-blue-400"}`} />
                          <span className="text-white/60">{a.name}</span>
                          <span className="text-white/25">{a.role}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-[10px] text-white/25">Empty workspace</div>
                  )}
                </button>
              ))}
            </div>
            <div className="flex justify-between">
              <button onClick={back} className="text-xs text-white/30 hover:text-white/60 transition-colors">Back</button>
              <button
                onClick={next}
                disabled={selectedTeam === null}
                className="rounded-lg bg-blue-500 px-6 py-2 text-xs font-bold text-white hover:bg-blue-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        )}

        {/* ── AGENTS ───────────────────────────────────────────────── */}
        {step === "agents" && (
          <div className="flex flex-col gap-6">
            <ProgressBar current={3} total={5} />
            <div>
              <h2 className="text-lg font-bold mb-1">Configure your agents</h2>
              <p className="text-xs text-white/40">
                Name them, assign roles, pick sprites. Head agents (Opus) plan and delegate. Builders (Sonnet) execute.
              </p>
            </div>
            <div className="flex flex-col gap-2 max-h-[380px] overflow-y-auto pr-1">
              {agents.map((agent, i) => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  sprites={sprites}
                  onUpdate={(patch) => updateAgent(i, patch)}
                  onRemove={() => removeAgent(i)}
                />
              ))}
            </div>
            <button
              onClick={addAgent}
              className="rounded-lg border border-dashed border-white/15 py-2 text-xs text-white/30 hover:border-white/30 hover:text-white/50 transition-all"
            >
              + Add agent
            </button>
            <div className="flex justify-between">
              <button onClick={back} className="text-xs text-white/30 hover:text-white/60 transition-colors">Back</button>
              <button
                onClick={next}
                className="rounded-lg bg-blue-500 px-6 py-2 text-xs font-bold text-white hover:bg-blue-400 transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        )}

        {/* ── MEMORY IMPORT ───────────────────────────────────────── */}
        {step === "memory" && (
          <div className="flex flex-col gap-6">
            <ProgressBar current={4} total={5} />
            <div>
              <h2 className="text-lg font-bold mb-1">Import Claude memory</h2>
              <p className="text-xs text-white/40">
                Seed your head agent with context from your existing Claude sessions.
              </p>
            </div>

            {memoryLoading && (
              <div className="flex items-center gap-3 py-8 justify-center">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-white/60" />
                <span className="text-xs text-white/40">Scanning ~/.claude/ ...</span>
              </div>
            )}

            {!memoryLoading && claudeMemory && !claudeMemory.found && (
              <div className="rounded-lg border border-white/10 bg-white/[0.02] p-6 text-center">
                <p className="text-xs text-white/40 mb-1">No Claude memory found</p>
                <p className="text-[10px] text-white/20">
                  If you&apos;ve used Claude Code before, memory files live in ~/.claude/
                </p>
              </div>
            )}

            {!memoryLoading && claudeMemory && claudeMemory.found && (
              <div className="flex flex-col gap-3 max-h-[340px] overflow-y-auto pr-1">
                {/* Global CLAUDE.md */}
                {claudeMemory.global && (
                  <label className="flex items-start gap-3 rounded-lg border border-white/10 bg-white/[0.02] p-3 cursor-pointer hover:border-white/20 transition-colors">
                    <input
                      type="checkbox"
                      checked={selectedMemory.has(claudeMemory.global.path)}
                      onChange={() => {
                        setSelectedMemory((prev) => {
                          const next = new Set(prev);
                          if (next.has(claudeMemory.global!.path)) next.delete(claudeMemory.global!.path);
                          else next.add(claudeMemory.global!.path);
                          return next;
                        });
                      }}
                      className="mt-0.5 accent-blue-500"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-bold">Global CLAUDE.md</span>
                        <span className="text-[9px] text-white/20">~/.claude/CLAUDE.md</span>
                      </div>
                      <pre className="text-[10px] text-white/30 whitespace-pre-wrap line-clamp-4 font-mono">
                        {claudeMemory.global.content}
                      </pre>
                    </div>
                  </label>
                )}

                {/* Per-project memory */}
                {claudeMemory.projects.map((project) => (
                  <div key={project.slug} className="rounded-lg border border-white/10 bg-white/[0.02]">
                    <button
                      onClick={() =>
                        setExpandedProject((prev) =>
                          prev === project.slug ? null : project.slug,
                        )
                      }
                      className="w-full flex items-center gap-2 p-3 text-left hover:bg-white/[0.02] transition-colors"
                    >
                      <span className="text-[10px] text-white/30">
                        {expandedProject === project.slug ? "▾" : "▸"}
                      </span>
                      <span className="text-xs font-bold flex-1">{project.label}</span>
                      <span className="text-[9px] text-white/20">
                        {project.files.length} file{project.files.length !== 1 ? "s" : ""}
                      </span>
                    </button>

                    {expandedProject === project.slug && (
                      <div className="flex flex-col gap-1 px-3 pb-3">
                        {project.files.map((file) => (
                          <label
                            key={file.path}
                            className="flex items-start gap-3 rounded-md bg-white/[0.02] p-2 cursor-pointer hover:bg-white/[0.04] transition-colors"
                          >
                            <input
                              type="checkbox"
                              checked={selectedMemory.has(file.path)}
                              onChange={() => {
                                setSelectedMemory((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(file.path)) next.delete(file.path);
                                  else next.add(file.path);
                                  return next;
                                });
                              }}
                              className="mt-0.5 accent-blue-500"
                            />
                            <div className="flex-1 min-w-0">
                              <span className="text-[10px] font-mono text-white/50">{file.name}</span>
                              <pre className="text-[10px] text-white/20 whitespace-pre-wrap line-clamp-3 font-mono mt-1">
                                {file.content}
                              </pre>
                            </div>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="flex justify-between">
              <button onClick={back} className="text-xs text-white/30 hover:text-white/60 transition-colors">Back</button>
              <button
                onClick={next}
                className="rounded-lg bg-blue-500 px-6 py-2 text-xs font-bold text-white hover:bg-blue-400 transition-colors"
              >
                {selectedMemory.size > 0 ? "Review" : "Skip"}
              </button>
            </div>
          </div>
        )}

        {/* ── REVIEW ───────────────────────────────────────────────── */}
        {step === "review" && (
          <div className="flex flex-col gap-6">
            <div>
              <h2 className="text-lg font-bold mb-1">Ready to build</h2>
              <p className="text-xs text-white/40">Review your workspace before creating it.</p>
            </div>

            <div className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
              <div className="flex items-baseline gap-3 mb-4">
                <span className="text-sm font-bold">{officeName || "My Office"}</span>
                <span className="text-[10px] text-white/20">{slug}</span>
              </div>

              {selectedRoom && (
                <div className="mb-4">
                  <div className="text-[9px] text-white/30 mb-1">Room</div>
                  <div className="text-xs text-white/60">
                    {selectedRoom.replace(/_layer1\.png$/, "").replace(/_/g, " ")}
                  </div>
                </div>
              )}

              <div className="text-[9px] text-white/30 mb-2">Agents ({agents.length})</div>
              <div className="flex flex-col gap-1.5">
                {agents.map((a) => (
                  <div key={a.id} className="flex items-center gap-2.5">
                    {a.visual?.premade && <SpriteMini file={a.visual.premade} size={12} />}
                    <span className="text-xs font-bold">{a.name || "(unnamed)"}</span>
                    <span className="text-[10px] text-white/30">{a.role || "(no role)"}</span>
                    <span className={`text-[9px] ml-auto ${a.model?.includes("opus") ? "text-purple-400/60" : "text-blue-400/60"}`}>
                      {a.model?.includes("opus") ? "opus" : "sonnet"}
                    </span>
                    {a.isHead && <span className="text-[8px] text-yellow-400/50">HEAD</span>}
                  </div>
                ))}
              </div>

              {selectedMemory.size > 0 && (
                <div className="mt-4">
                  <div className="text-[9px] text-white/30 mb-1">Imported memory</div>
                  <div className="text-xs text-white/60">
                    {selectedMemory.size} file{selectedMemory.size !== 1 ? "s" : ""} selected — will seed head agent
                  </div>
                </div>
              )}
            </div>

            {error && (
              <div className="rounded-lg border border-red-400/30 bg-red-400/5 px-4 py-2 text-xs text-red-400">
                {error}
              </div>
            )}

            <div className="flex justify-between">
              <button onClick={back} className="text-xs text-white/30 hover:text-white/60 transition-colors">Back</button>
              <button
                onClick={createWorkspace}
                disabled={saving}
                className="rounded-lg bg-blue-500 px-8 py-3 text-sm font-bold text-white hover:bg-blue-400 transition-colors disabled:opacity-50"
              >
                {saving ? "Creating..." : "Create workspace"}
              </button>
            </div>
          </div>
        )}

        {/* ── DONE ─────────────────────────────────────────────────── */}
        {step === "done" && (
          <div className="flex flex-col items-center text-center gap-6">
            <div className="text-4xl">
              <svg width="48" height="48" viewBox="0 0 48 48" fill="none" className="text-green-400">
                <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="2" />
                <path d="M14 24l7 7 13-13" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div>
              <h2 className="text-lg font-bold mb-1">Workspace created</h2>
              <p className="text-xs text-white/40">
                <strong className="text-white/60">{officeName}</strong> is ready. Your agents are at their desks.
              </p>
            </div>
            <div className="flex flex-col gap-2 w-full max-w-xs">
              <a
                href="/"
                className="rounded-lg bg-blue-500 px-8 py-3 text-sm font-bold text-white hover:bg-blue-400 transition-colors text-center"
              >
                Open workspace
              </a>
              <a
                href="/workspace-builder"
                className="rounded-lg border border-white/10 px-6 py-2 text-xs text-white/40 hover:text-white/60 hover:border-white/20 transition-colors text-center"
              >
                Fine-tune in Workspace Builder
              </a>
            </div>
            <p className="text-[10px] text-white/20 max-w-sm leading-relaxed">
              Tip: Once in the workspace, click any agent to chat with them.
              Opus agents plan work and delegate to Sonnet builders.
              Press Ctrl+K to switch between offices.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Shared components ───────────────────────────────────────────────────────

function FeatureCard({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <div className="text-xs font-bold mb-1">{title}</div>
      <div className="text-[10px] text-white/35 leading-relaxed">{desc}</div>
    </div>
  );
}
