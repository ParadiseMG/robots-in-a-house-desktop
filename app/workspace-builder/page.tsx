"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { OfficeConfig, AgentConfig, RoomTemplate } from "@/lib/office-types";

// ── Constants ────────────────────────────────────────────────────────────────

const MODELS = ["claude-opus-4-6", "claude-sonnet-4-20250514"];
const MODEL_LABEL: Record<string, string> = { "claude-opus-4-6": "Opus", "claude-sonnet-4-20250514": "Sonnet" };
const SPRITE_TILE = 16;
const SPRITE_CHAR_W = 16;
const SPRITE_CHAR_H = 32;
const SPRITE_IDLE_Y = 32;
const SPRITE_S_COL = 18;

// ── Image helpers ────────────────────────────────────────────────────────────

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

// ── Sprite thumbnail ─────────────────────────────────────────────────────────

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
  return <canvas ref={ref} width={size} height={size * 2} style={{ imageRendering: "pixelated", width: size, height: size * 2, pointerEvents: "none" }} />;
}

// ── Read-only room preview ───────────────────────────────────────────────────

function RoomPreview({ config }: { config: OfficeConfig }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [roomImg, setRoomImg] = useState<HTMLImageElement | null>(null);
  const [spriteImgs, setSpriteImgs] = useState<Map<string, HTMLImageElement>>(new Map());

  const pr = config.theme.premadeRoom;
  const tileW = config.tile.w;
  const tileH = config.tile.h;
  const canvasW = pr ? pr.pixelWidth * (tileW / pr.sourceTileSize) : config.grid.cols * tileW;
  const canvasH = pr ? pr.pixelHeight * (tileH / pr.sourceTileSize) : config.grid.rows * tileH;

  useEffect(() => {
    if (!pr?.layers?.[0]) { setRoomImg(null); return; }
    loadImg(`/sprites/interiors/premade_rooms/${pr.layers[0]}`).then(setRoomImg).catch(() => setRoomImg(null));
  }, [pr?.layers?.[0]]);

  useEffect(() => {
    const map = new Map<string, HTMLImageElement>();
    const promises = config.agents.map(async (a) => {
      if (!a.visual?.premade) return;
      try {
        const img = await loadImg(`/sprites/characters/${a.visual.premade}`);
        map.set(a.id, img);
      } catch { /* skip */ }
    });
    Promise.all(promises).then(() => setSpriteImgs(new Map(map)));
  }, [config.agents]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    ctx.fillStyle = config.theme.bg || "#1a1a2e";
    ctx.fillRect(0, 0, canvasW, canvasH);

    if (roomImg && pr) {
      const scale = tileW / pr.sourceTileSize;
      ctx.drawImage(roomImg, 0, 0, pr.pixelWidth, pr.pixelHeight, 0, 0, pr.pixelWidth * scale, pr.pixelHeight * scale);
    }

    // Draw agents at their desks
    for (const agent of config.agents) {
      const desk = config.desks.find((d) => d.id === agent.deskId);
      if (!desk) continue;
      const px = desk.gridX * tileW;
      const py = desk.gridY * tileH;

      const spriteImg = spriteImgs.get(agent.id);
      if (spriteImg) {
        const spriteScale = tileW / SPRITE_TILE;
        const drawW = SPRITE_CHAR_W * spriteScale;
        const drawH = SPRITE_CHAR_H * spriteScale;
        ctx.drawImage(spriteImg, SPRITE_S_COL * SPRITE_TILE, SPRITE_IDLE_Y, SPRITE_CHAR_W, SPRITE_CHAR_H, px, py - drawH + tileH, drawW, drawH);
      } else {
        ctx.fillStyle = config.theme.accent || "#5aa0ff";
        ctx.beginPath();
        ctx.arc(px + tileW / 2, py + tileH / 2, tileW * 0.3, 0, Math.PI * 2);
        ctx.fill();
      }

      // Name label
      ctx.font = `bold ${Math.max(9, tileW * 0.22)}px monospace`;
      ctx.textAlign = "center";
      const textY = spriteImg ? py - (SPRITE_CHAR_H * (tileW / SPRITE_TILE)) + tileH - 4 : py - 4;
      const tw = ctx.measureText(agent.name).width + 8;
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.beginPath();
      ctx.roundRect(px + tileW / 2 - tw / 2, textY - 8, tw, 12, 4);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.fillText(agent.name, px + tileW / 2, textY);
    }

    // Draw empty desk markers (desks without agents)
    const assignedDeskIds = new Set(config.agents.map((a) => a.deskId));
    for (const desk of config.desks) {
      if (assignedDeskIds.has(desk.id)) continue;
      const px = desk.gridX * tileW;
      const py = desk.gridY * tileH;
      ctx.strokeStyle = "rgba(255,255,255,0.15)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(px + 2, py + 2, tileW - 4, tileH - 4);
      ctx.setLineDash([]);

      // Show desk label or "+" for empty slots
      ctx.textAlign = "center";
      if (desk.label) {
        ctx.fillStyle = "rgba(255,255,255,0.12)";
        ctx.font = `${Math.max(7, tileW * 0.18)}px monospace`;
        ctx.fillText(desk.label, px + tileW / 2, py + tileH / 2 + 2);
      } else {
        ctx.fillStyle = "rgba(255,255,255,0.08)";
        ctx.font = `${Math.max(8, tileW * 0.35)}px monospace`;
        ctx.fillText("+", px + tileW / 2, py + tileH / 2 + 3);
      }
    }
  }, [config, roomImg, spriteImgs, canvasW, canvasH, tileW, tileH, pr]);

  return (
    <canvas
      ref={canvasRef}
      width={canvasW}
      height={canvasH}
      className="w-full h-auto"
      style={{ imageRendering: "pixelated", maxHeight: "calc(100vh - 120px)" }}
    />
  );
}

// ── Template card ────────────────────────────────────────────────────────────

function TemplateCard({ tmpl, onClick }: { tmpl: RoomTemplate; onClick: () => void }) {
  const previewLayer = tmpl.preview ?? tmpl.theme.premadeRoom?.layers?.[0] ?? null;

  return (
    <button
      onClick={onClick}
      className="flex flex-col rounded-xl border border-white/8 bg-gray-900/40 hover:border-white/20 hover:bg-gray-900/80 text-left transition-all overflow-hidden group"
    >
      <div className="relative h-28 w-full overflow-hidden bg-gray-900 flex-shrink-0">
        {previewLayer ? (
          <img
            src={`/sprites/interiors/premade_rooms/${previewLayer}`}
            alt={tmpl.name}
            className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity"
            style={{ imageRendering: "pixelated" }}
          />
        ) : (
          <div className="w-full h-full" style={{ backgroundColor: tmpl.theme.bg || "#1a1a2e" }} />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-gray-950/80 via-transparent to-transparent" />
        <div className="absolute bottom-2 left-3 right-3">
          <div className="text-[13px] font-bold text-white group-hover:text-yellow-400 transition-colors">
            {tmpl.name}
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-2 p-3 flex-1">
        <div className="text-[10px] text-white/40 leading-snug line-clamp-2">
          {tmpl.description}
        </div>
        <div className="flex items-center gap-2 mt-auto pt-1">
          <span className="rounded-full bg-white/5 px-2 py-0.5 text-[9px] text-white/30">
            {tmpl.capacity.min}&#8211;{tmpl.capacity.max} agents
          </span>
          <span className="rounded-full bg-white/5 px-2 py-0.5 text-[9px] text-white/30">
            {tmpl.desks.length} desks
          </span>
        </div>
      </div>
    </button>
  );
}

// ── Office card (existing office) ────────────────────────────────────────────

function OfficeCard({ config, onClick }: { config: OfficeConfig; onClick: () => void }) {
  const previewLayer = config.theme.premadeRoom?.layers?.[0];

  return (
    <button
      onClick={onClick}
      className="flex items-center gap-3 rounded-lg border border-white/8 bg-gray-900/40 hover:border-white/20 hover:bg-gray-900/80 text-left transition-all overflow-hidden px-3 py-2.5 group"
    >
      <div className="w-16 h-10 rounded overflow-hidden flex-shrink-0 bg-gray-900">
        {previewLayer ? (
          <img
            src={`/sprites/interiors/premade_rooms/${previewLayer}`}
            alt={config.name}
            className="w-full h-full object-cover"
            style={{ imageRendering: "pixelated" }}
          />
        ) : (
          <div className="w-full h-full" style={{ backgroundColor: config.theme.bg }} />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[12px] font-bold text-white group-hover:text-yellow-400 transition-colors truncate">
          {config.name}
        </div>
        <div className="text-[9px] text-white/30">
          {config.agents.length} agent{config.agents.length !== 1 ? "s" : ""} &middot; {config.desks.length} desks
        </div>
      </div>
      <span className="text-[10px] text-white/15 group-hover:text-white/40 transition-colors">Edit &rarr;</span>
    </button>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

type View =
  | { kind: "catalog" }
  | { kind: "create"; template: RoomTemplate }
  | { kind: "edit"; slug: string };

export default function WorkspaceBuilderPage() {
  const [allConfigs, setAllConfigs] = useState<Record<string, OfficeConfig> | null>(null);
  const [templates, setTemplates] = useState<RoomTemplate[] | null>(null);
  const [sprites, setSprites] = useState<string[]>([]);
  const [view, setView] = useState<View>({ kind: "catalog" });

  // Create-office form state
  const [createName, setCreateName] = useState("");
  const [createSlug, setCreateSlug] = useState("");
  const [createSlugTouched, setCreateSlugTouched] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Edit state
  const [config, setConfig] = useState<OfficeConfig | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load data on mount
  useEffect(() => {
    Promise.all([
      fetch("/api/workspace-builder/configs").then((r) => r.json()),
      fetch("/api/templates").then((r) => r.json()),
      fetch("/api/workspace-builder/sprites").then((r) => r.json()),
    ]).then(([configs, tmplData, spriteData]) => {
      setAllConfigs(configs);
      setTemplates(tmplData.templates ?? []);
      setSprites(spriteData.sprites || []);
    }).catch(console.error);
  }, []);

  // ── Create flow ────────────────────────────────────────────────────────────

  const startCreate = useCallback((tmpl: RoomTemplate) => {
    setCreateName("");
    setCreateSlug("");
    setCreateSlugTouched(false);
    setCreateError(null);
    setView({ kind: "create", template: tmpl });
  }, []);

  const handleNameChange = useCallback((v: string) => {
    setCreateName(v);
    if (!createSlugTouched) {
      setCreateSlug(v.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
    }
  }, [createSlugTouched]);

  const handleCreate = useCallback(async () => {
    if (view.kind !== "create") return;
    const slug = createSlug.trim();
    const name = createName.trim();
    if (!slug || !name) return;
    if (allConfigs && allConfigs[slug]) {
      setCreateError(`"${slug}" already exists.`);
      return;
    }

    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/templates/instantiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId: view.template.id,
          slug,
          name,
          addToStation: true,
        }),
      });
      const data = (await res.json()) as { office?: OfficeConfig; error?: string };
      if (!res.ok || !data.office) {
        setCreateError(data.error ?? `Server error (${res.status})`);
        return;
      }
      const newCfg = data.office;
      setAllConfigs((prev) => prev ? { ...prev, [slug]: structuredClone(newCfg) } : { [slug]: structuredClone(newCfg) });
      setConfig(structuredClone(newCfg));
      setSelectedAgentId(null);
      setView({ kind: "edit", slug });
    } catch (e) {
      setCreateError(String(e));
    } finally {
      setCreating(false);
    }
  }, [view, createName, createSlug, allConfigs]);

  // ── Edit flow ──────────────────────────────────────────────────────────────

  const openOffice = useCallback((slug: string) => {
    if (!allConfigs?.[slug]) return;
    setConfig(structuredClone(allConfigs[slug]));
    setSelectedAgentId(null);
    setView({ kind: "edit", slug });
  }, [allConfigs]);

  const autoSave = useCallback((slug: string, cfg: OfficeConfig) => {
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/workspace-builder/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, config: cfg }),
        });
        if (res.ok) {
          setAllConfigs((prev) => prev ? { ...prev, [slug]: structuredClone(cfg) } : prev);
        }
      } catch { /* silent */ }
    }, 800);
  }, []);

  const updateConfig = useCallback((fn: (c: OfficeConfig) => void) => {
    setConfig((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      fn(next);
      if (view.kind === "edit") autoSave(view.slug, next);
      return next;
    });
  }, [view, autoSave]);

  const addAgent = useCallback(() => {
    if (view.kind !== "edit" || !config) return;
    // Find first unassigned desk
    const assignedDeskIds = new Set(config.agents.map((a) => a.deskId));
    const openDesk = config.desks.find((d) => !assignedDeskIds.has(d.id));
    if (!openDesk) return; // no empty desks

    const id = `agent-${Date.now()}`;
    updateConfig((c) => {
      c.agents.push({
        id,
        deskId: openDesk.id,
        name: "New Agent",
        role: "Role",
        spritePack: "limezu/office/auto",
        visual: { premade: sprites[0] || "premade_02.png" },
        isReal: true,
        cwd: `agent-workspaces/${view.slug}/${id}`,
        allowedTools: ["Read", "Edit", "Write", "Grep", "Glob", "Bash", "WebSearch", "WebFetch"],
        model: MODELS[1],
      });
    });
    setSelectedAgentId(id);
  }, [view, config, sprites, updateConfig]);

  const removeAgent = useCallback((agentId: string) => {
    if (!confirm("Remove this agent?")) return;
    updateConfig((c) => {
      c.agents = c.agents.filter((a) => a.id !== agentId);
    });
    setSelectedAgentId(null);
  }, [updateConfig]);

  const updateAgent = useCallback((agentId: string, patch: Partial<AgentConfig>) => {
    updateConfig((c) => {
      const agent = c.agents.find((a) => a.id === agentId);
      if (agent) Object.assign(agent, patch);
    });
  }, [updateConfig]);

  const refreshSprites = useCallback(() => {
    fetch("/api/workspace-builder/sprites")
      .then((r) => r.json())
      .then((data) => setSprites(data.sprites || []))
      .catch(console.error);
  }, []);

  // ── Delete flow ────────────────────────────────────────────────────────────

  const [deleting, setDeleting] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const deleteOffice = useCallback(async () => {
    if (view.kind !== "edit") return;
    setDeleting(true);
    try {
      const res = await fetch("/api/workspace-builder/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: view.slug }),
      });
      if (!res.ok) return;
      setAllConfigs((prev) => {
        if (!prev) return prev;
        const next = { ...prev };
        delete next[view.slug];
        return next;
      });
      setConfig(null);
      setDeleteConfirmOpen(false);
      setView({ kind: "catalog" });
    } catch { /* silent */ } finally {
      setDeleting(false);
    }
  }, [view]);

  // ── Add desk ───────────────────────────────────────────────────────────────

  const addDesk = useCallback(() => {
    if (!config) return;
    // Find an open grid position: scan for a cell not occupied by an existing desk
    const occupied = new Set(config.desks.map((d) => `${d.gridX},${d.gridY}`));
    const room = config.rooms[0];
    const startX = room ? room.gridX + 1 : 2;
    const startY = room ? room.gridY + 1 : 2;
    const maxX = room ? room.gridX + room.w : config.grid.cols - 1;
    const maxY = room ? room.gridY + room.h : config.grid.rows - 1;

    let placed = false;
    for (let y = startY; y <= maxY && !placed; y += 2) {
      for (let x = startX; x <= maxX && !placed; x += 3) {
        if (!occupied.has(`${x},${y}`)) {
          const deskId = `desk-${config.slug}-${config.desks.length}`;
          updateConfig((c) => {
            c.desks.push({
              id: deskId,
              roomId: c.rooms[0]?.id || "main",
              gridX: x,
              gridY: y,
              facing: "S" as const,
              label: `desk ${c.desks.length + 1}`,
            });
          });
          placed = true;
        }
      }
    }
  }, [config, updateConfig]);

  // ── Loading ────────────────────────────────────────────────────────────────

  if (!allConfigs || !templates) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-950 text-white/30">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/10 border-t-blue-400" />
          <span className="font-mono text-xs">loading...</span>
        </div>
      </div>
    );
  }

  const existingOffices = Object.entries(allConfigs);
  const openDesks = config ? config.desks.length - config.agents.length : 0;

  // ── Catalog view ───────────────────────────────────────────────────────────

  if (view.kind === "catalog") {
    return (
      <div className="min-h-screen bg-gray-950 font-mono text-white">
        <div className="mx-auto max-w-4xl px-6 py-10">
          {/* Header */}
          <div className="flex items-center justify-between mb-8">
            <div>
              <h1 className="text-lg font-bold tracking-wide">Workspace Builder</h1>
              <p className="text-[11px] text-white/30 mt-1">Pick a room template to create a new office.</p>
            </div>
            <a href="/" className="text-[10px] text-white/30 hover:text-white/60 transition-colors">
              &larr; back to station
            </a>
          </div>

          {/* Template catalog */}
          <div className="mb-10">
            <h2 className="text-[11px] text-white/40 font-bold uppercase tracking-wider mb-4">Templates</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {templates.map((tmpl) => (
                <TemplateCard key={tmpl.id} tmpl={tmpl} onClick={() => startCreate(tmpl)} />
              ))}
            </div>
          </div>

          {/* Existing offices */}
          <div>
            <h2 className="text-[11px] text-white/40 font-bold uppercase tracking-wider mb-4">Your Offices</h2>
            {existingOffices.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {existingOffices.map(([slug, cfg]) => (
                  <OfficeCard key={slug} config={cfg as OfficeConfig} onClick={() => openOffice(slug)} />
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-white/10 py-8 text-center">
                <div className="text-[11px] text-white/20">No offices yet.</div>
                <div className="text-[10px] text-white/12 mt-1">Pick a template above to get started.</div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Create view ────────────────────────────────────────────────────────────

  if (view.kind === "create") {
    const tmpl = view.template;
    const previewLayer = tmpl.preview ?? tmpl.theme.premadeRoom?.layers?.[0] ?? null;
    const slugTaken = !!(allConfigs && createSlug && allConfigs[createSlug]);

    return (
      <div className="min-h-screen bg-gray-950 font-mono text-white">
        <div className="mx-auto max-w-lg px-6 py-10">
          {/* Back */}
          <button
            onClick={() => setView({ kind: "catalog" })}
            className="text-[10px] text-white/30 hover:text-white/60 transition-colors mb-6"
          >
            &larr; back to templates
          </button>

          {/* Template preview */}
          <div className="rounded-xl border border-white/10 overflow-hidden mb-6">
            <div className="h-40 overflow-hidden bg-gray-900">
              {previewLayer ? (
                <img
                  src={`/sprites/interiors/premade_rooms/${previewLayer}`}
                  alt={tmpl.name}
                  className="w-full h-full object-cover"
                  style={{ imageRendering: "pixelated" }}
                />
              ) : (
                <div className="w-full h-full" style={{ backgroundColor: tmpl.theme.bg || "#1a1a2e" }} />
              )}
            </div>
            <div className="px-4 py-3 bg-gray-900/60">
              <div className="text-[13px] font-bold">{tmpl.name}</div>
              <div className="text-[10px] text-white/40 mt-1">{tmpl.description}</div>
              <div className="flex gap-3 mt-2 text-[9px] text-white/25">
                <span>{tmpl.capacity.min}&#8211;{tmpl.capacity.max} agents</span>
                <span>{tmpl.desks.length} desks</span>
              </div>
            </div>
          </div>

          {/* Name */}
          <div className="mb-4">
            <label className="text-[10px] text-white/40 mb-1.5 block">Office Name</label>
            <input
              autoFocus
              type="text"
              value={createName}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="e.g. Design Studio"
              className="w-full rounded-lg border border-white/10 bg-gray-900 px-3 py-2.5 text-[12px] text-white outline-none focus:border-yellow-400/40"
              onKeyDown={(e) => { if (e.key === "Enter") void handleCreate(); }}
            />
          </div>

          {/* Slug */}
          <div className="mb-6">
            <label className="text-[10px] text-white/40 mb-1.5 block">Slug</label>
            <input
              type="text"
              value={createSlug}
              onChange={(e) => {
                setCreateSlugTouched(true);
                setCreateSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"));
              }}
              placeholder="e.g. design-studio"
              className="w-full rounded-lg border border-white/10 bg-gray-900 px-3 py-2.5 text-[12px] text-white/50 outline-none focus:border-yellow-400/40 font-mono"
              onKeyDown={(e) => { if (e.key === "Enter") void handleCreate(); }}
            />
            {slugTaken && <div className="mt-1.5 text-[9px] text-red-400">Already in use.</div>}
          </div>

          {/* Error */}
          {createError && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-[10px] text-red-400 mb-4">
              {createError}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3">
            <button
              onClick={() => setView({ kind: "catalog" })}
              className="flex-1 rounded-lg border border-white/10 py-2.5 text-[11px] text-white/30 hover:text-white/60 hover:border-white/20 transition-all"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleCreate()}
              disabled={!createName.trim() || !createSlug.trim() || creating || slugTaken}
              className="flex-1 rounded-lg bg-yellow-400/15 border border-yellow-400/30 py-2.5 text-[11px] font-bold text-yellow-400 hover:bg-yellow-400/25 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {creating ? "Creating..." : "Create Office"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Edit view ──────────────────────────────────────────────────────────────

  if (!config) return null;
  const selectedAgent = config.agents.find((a) => a.id === selectedAgentId);

  return (
    <div className="flex h-screen overflow-hidden bg-gray-950 font-mono text-white">
      {/* LEFT: room preview */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setView({ kind: "catalog" })}
              className="text-[10px] text-white/30 hover:text-white/60 transition-colors"
            >
              &larr;
            </button>
            <span className="text-sm font-bold">{config.name}</span>
            <span className="text-[9px] text-white/20">{config.slug}</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setDeleteConfirmOpen(true)}
              className="text-[9px] text-red-400/30 hover:text-red-400 transition-colors"
            >
              Delete Office
            </button>
            <a href="/" className="text-[10px] text-white/30 hover:text-white/60 transition-colors">
              back to station
            </a>
          </div>
        </div>

        {/* Delete confirmation */}
        {deleteConfirmOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/75"
            onClick={(e) => { if (e.target === e.currentTarget) setDeleteConfirmOpen(false); }}
          >
            <div className="w-[400px] rounded-xl border border-white/10 bg-gray-950 p-5">
              <div className="text-[13px] font-bold text-white mb-2">Delete {config.name}?</div>
              <div className="text-[10px] text-white/40 mb-3">
                This removes the office config and station module. Agent workspace files are kept on disk.
              </div>
              {config.agents.length > 0 && (
                <div className="rounded-lg border border-white/8 bg-gray-900/60 p-3 mb-4">
                  <div className="text-[9px] text-white/30 mb-2">
                    {config.agents.length} agent{config.agents.length !== 1 ? "s" : ""} will be unassigned:
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {config.agents.map((a) => (
                      <span key={a.id} className="rounded-full bg-white/5 px-2 py-0.5 text-[9px] text-white/40">
                        {a.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => setDeleteConfirmOpen(false)}
                  className="flex-1 rounded-lg border border-white/10 py-2 text-[10px] text-white/30 hover:text-white/60 hover:border-white/20 transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void deleteOffice()}
                  disabled={deleting}
                  className="flex-1 rounded-lg bg-red-500/15 border border-red-500/30 py-2 text-[10px] font-bold text-red-400 hover:bg-red-500/25 transition-all disabled:opacity-30"
                >
                  {deleting ? "Deleting..." : "Delete Office"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Room canvas */}
        <div className="flex-1 overflow-auto p-4 flex items-center justify-center">
          <div className="inline-block rounded-lg overflow-hidden border border-white/10 shadow-2xl">
            <RoomPreview config={config} />
          </div>
        </div>
      </div>

      {/* RIGHT: agent panel */}
      <div className="flex w-[340px] flex-shrink-0 flex-col overflow-hidden border-l border-white/10">
        {/* Agent list header */}
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="text-[11px] font-bold text-white/60">
            Agents <span className="text-white/20 font-normal">{config.agents.length}/{config.desks.length}</span>
          </div>
          <div className="flex items-center gap-1.5">
            {openDesks > 0 ? (
              <button
                onClick={addAgent}
                className="rounded-md bg-yellow-400/10 border border-yellow-400/20 px-2.5 py-1 text-[10px] text-yellow-400/80 hover:bg-yellow-400/20 hover:text-yellow-400 transition-all"
              >
                + Add Agent
              </button>
            ) : (
              <span className="text-[9px] text-white/20">All desks filled</span>
            )}
            <button
              onClick={addDesk}
              className="rounded-md border border-white/10 px-2 py-1 text-[9px] text-white/25 hover:text-white/50 hover:border-white/20 transition-all"
              title="Add a new desk slot"
            >
              + Desk
            </button>
          </div>
        </div>

        {/* Agent list */}
        <div className="flex-1 overflow-y-auto">
          {config.agents.length === 0 && (
            <div className="flex flex-col items-center justify-center h-48 text-white/15 text-[10px]">
              <div className="mb-2">No agents yet.</div>
              {openDesks > 0 && (
                <button
                  onClick={addAgent}
                  className="rounded-md border border-white/10 px-3 py-1.5 text-[10px] text-white/30 hover:text-white/60 hover:border-white/20 transition-all"
                >
                  + Add your first agent
                </button>
              )}
            </div>
          )}

          {config.agents.map((agent) => {
            const isSelected = selectedAgentId === agent.id;
            const desk = config.desks.find((d) => d.id === agent.deskId);

            return (
              <div key={agent.id}>
                {/* Agent row */}
                <button
                  onClick={() => setSelectedAgentId(isSelected ? null : agent.id)}
                  className={`flex items-center gap-2.5 w-full px-4 py-2.5 text-left transition-all ${
                    isSelected
                      ? "bg-white/5"
                      : "hover:bg-white/[0.02]"
                  }`}
                >
                  {agent.visual?.premade && <SpriteMini file={agent.visual.premade} size={14} />}
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-bold truncate">{agent.name}</div>
                    <div className="text-[9px] text-white/30 truncate">{agent.role}</div>
                  </div>
                  <div className="flex flex-col items-end gap-0.5">
                    <span className="text-[9px] text-white/20">
                      {MODEL_LABEL[(agent.model || MODELS[1])] || "Sonnet"}
                    </span>
                    {desk?.label && (
                      <span className="text-[8px] text-white/15 italic">{desk.label}</span>
                    )}
                  </div>
                </button>

                {/* Expanded editor */}
                {isSelected && (
                  <div className="px-4 pb-4 pt-1 bg-white/[0.02] border-b border-white/5">
                    <div className="flex flex-col gap-3">
                      {/* Name + Role */}
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-[9px] text-white/30 mb-0.5 block">Name</label>
                          <input
                            type="text"
                            value={agent.name}
                            onChange={(e) => updateAgent(agent.id, { name: e.target.value })}
                            className="w-full rounded-md border border-white/10 bg-gray-900 px-2 py-1.5 text-[10px] text-white outline-none focus:border-yellow-400/40"
                          />
                        </div>
                        <div>
                          <label className="text-[9px] text-white/30 mb-0.5 block">Role</label>
                          <input
                            type="text"
                            value={agent.role}
                            onChange={(e) => updateAgent(agent.id, { role: e.target.value })}
                            className="w-full rounded-md border border-white/10 bg-gray-900 px-2 py-1.5 text-[10px] text-white outline-none focus:border-yellow-400/40"
                          />
                        </div>
                      </div>

                      {/* Model */}
                      <div>
                        <label className="text-[9px] text-white/30 mb-0.5 block">Model</label>
                        <div className="flex gap-1.5">
                          {MODELS.map((m) => (
                            <button
                              key={m}
                              onClick={() => updateAgent(agent.id, { model: m })}
                              className={`flex-1 rounded-md py-1.5 text-[10px] transition-all ${
                                (agent.model || MODELS[1]) === m
                                  ? "bg-yellow-400/15 text-yellow-400 border border-yellow-400/30"
                                  : "text-white/30 border border-white/8 hover:border-white/15"
                              }`}
                            >
                              {MODEL_LABEL[m]}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Sprite picker */}
                      <div>
                        <label className="text-[9px] text-white/30 mb-1 block">Sprite</label>
                        <div className="flex gap-1 overflow-x-auto pb-1">
                          {sprites.map((s) => (
                            <button
                              key={s}
                              onClick={() => updateAgent(agent.id, { visual: { premade: s } })}
                              className={`flex-shrink-0 rounded-md p-0.5 transition-all ${
                                agent.visual?.premade === s
                                  ? "ring-2 ring-yellow-400 bg-gray-800"
                                  : "bg-gray-900/60 hover:bg-gray-800 border border-white/5"
                              }`}
                            >
                              <SpriteMini file={s} size={14} />
                            </button>
                          ))}
                        </div>
                        <div className="flex gap-1.5 mt-1.5">
                          <a
                            href="/sprite-maker"
                            target="_blank"
                            className="flex items-center gap-1 rounded-md border border-yellow-400/20 bg-yellow-400/5 px-2 py-1 text-[9px] text-yellow-400/70 hover:bg-yellow-400/10 hover:text-yellow-400 transition-all"
                          >
                            Create Sprite
                          </a>
                          <label className="flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[9px] text-white/30 hover:text-white/50 hover:border-white/20 transition-all cursor-pointer">
                            Import PNG
                            <input
                              type="file"
                              accept=".png"
                              className="hidden"
                              onChange={async (e) => {
                                const file = e.target.files?.[0];
                                if (!file) return;
                                const name = file.name.replace(/\.png$/i, "").replace(/[^a-zA-Z0-9_-]/g, "_");
                                const reader = new FileReader();
                                reader.onload = async () => {
                                  try {
                                    const res = await fetch("/api/sprite-maker/save", {
                                      method: "POST",
                                      headers: { "Content-Type": "application/json" },
                                      body: JSON.stringify({ name, imageData: reader.result }),
                                    });
                                    if (!res.ok) throw new Error(await res.text());
                                    const premade = `premade_${name}.png`;
                                    updateAgent(agent.id, { visual: { premade } });
                                    refreshSprites();
                                  } catch (err) {
                                    alert("Import failed: " + err);
                                  }
                                };
                                reader.readAsDataURL(file);
                                e.target.value = "";
                              }}
                            />
                          </label>
                        </div>
                      </div>

                      {/* Remove */}
                      <button
                        onClick={() => removeAgent(agent.id)}
                        className="text-[9px] text-red-400/40 hover:text-red-400 transition-colors self-start mt-1"
                      >
                        Remove agent
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
