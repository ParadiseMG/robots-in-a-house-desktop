"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { OfficeConfig, DeskConfig, AgentConfig } from "@/lib/office-types";

// ── Constants ────────────────────────────────────────────────────────────────

const FACING_OPTIONS = ["S", "E", "N", "W"] as const;
const FACING_ARROW: Record<string, string> = { N: "\u2191", E: "\u2192", S: "\u2193", W: "\u2190" };
const MODELS = ["claude-opus-4-6", "claude-sonnet-4-20250514"];
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

// ── Sprite thumbnail component ───────────────────────────────────────────────

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

// ── Room canvas with draggable agents ────────────────────────────────────────

function RoomCanvas({
  config,
  selectedAgentId,
  onSelectAgent,
  onMoveDesk,
}: {
  config: OfficeConfig;
  selectedAgentId: string | null;
  onSelectAgent: (id: string | null) => void;
  onMoveDesk: (deskId: string, gridX: number, gridY: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [roomImg, setRoomImg] = useState<HTMLImageElement | null>(null);
  const [spriteImgs, setSpriteImgs] = useState<Map<string, HTMLImageElement>>(new Map());
  const dragRef = useRef<{ deskId: string; startX: number; startY: number; offsetX: number; offsetY: number } | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);

  const pr = config.theme.premadeRoom;
  const tileW = config.tile.w;
  const tileH = config.tile.h;
  const canvasW = pr ? pr.pixelWidth * (tileW / pr.sourceTileSize) : config.grid.cols * tileW;
  const canvasH = pr ? pr.pixelHeight * (tileH / pr.sourceTileSize) : config.grid.rows * tileH;

  // Load room image
  useEffect(() => {
    if (!pr?.layers?.[0]) { setRoomImg(null); return; }
    loadImg(`/sprites/interiors/premade_rooms/${pr.layers[0]}`).then(setRoomImg).catch(() => setRoomImg(null));
  }, [pr?.layers?.[0]]);

  // Load agent sprites
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

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    // Background
    ctx.fillStyle = config.theme.bg || "#1a1a2e";
    ctx.fillRect(0, 0, canvasW, canvasH);

    // Room image
    if (roomImg && pr) {
      const scale = tileW / pr.sourceTileSize;
      ctx.drawImage(roomImg, 0, 0, pr.pixelWidth, pr.pixelHeight, 0, 0, pr.pixelWidth * scale, pr.pixelHeight * scale);
    }

    // Grid overlay (subtle)
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 0.5;
    for (let x = 0; x <= canvasW; x += tileW) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvasH); ctx.stroke();
    }
    for (let y = 0; y <= canvasH; y += tileH) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvasW, y); ctx.stroke();
    }

    // Draw agents
    for (const agent of config.agents) {
      const desk = config.desks.find((d) => d.id === agent.deskId);
      if (!desk) continue;

      const isDragging = dragRef.current?.deskId === desk.id && dragPos;
      const px = isDragging ? dragPos!.x : desk.gridX * tileW;
      const py = isDragging ? dragPos!.y : desk.gridY * tileH;
      const isSelected = selectedAgentId === agent.id;

      // Agent sprite
      const spriteImg = spriteImgs.get(agent.id);
      if (spriteImg) {
        const spriteScale = tileW / SPRITE_TILE;
        const drawW = SPRITE_CHAR_W * spriteScale;
        const drawH = SPRITE_CHAR_H * spriteScale;
        ctx.drawImage(
          spriteImg,
          SPRITE_S_COL * SPRITE_TILE, SPRITE_IDLE_Y,
          SPRITE_CHAR_W, SPRITE_CHAR_H,
          px, py - drawH + tileH,
          drawW, drawH
        );
      } else {
        // Fallback dot
        ctx.fillStyle = isSelected ? "#facc15" : config.theme.accent || "#5aa0ff";
        ctx.beginPath();
        ctx.arc(px + tileW / 2, py + tileH / 2, tileW * 0.3, 0, Math.PI * 2);
        ctx.fill();
      }

      // Selection ring
      if (isSelected) {
        ctx.strokeStyle = "#facc15";
        ctx.lineWidth = 2;
        ctx.strokeRect(px - 1, py - 1, tileW + 2, tileH + 2);
      }

      // Name label
      ctx.font = `bold ${Math.max(9, tileW * 0.22)}px monospace`;
      ctx.textAlign = "center";
      const textY = spriteImg ? py - (SPRITE_CHAR_H * (tileW / SPRITE_TILE)) + tileH - 4 : py - 4;

      // Background pill
      const name = agent.name;
      const tw = ctx.measureText(name).width + 8;
      ctx.fillStyle = isSelected ? "rgba(250,204,21,0.9)" : "rgba(0,0,0,0.7)";
      ctx.beginPath();
      ctx.roundRect(px + tileW / 2 - tw / 2, textY - 8, tw, 12, 4);
      ctx.fill();
      ctx.fillStyle = isSelected ? "#000" : "#fff";
      ctx.fillText(name, px + tileW / 2, textY);

      // Facing arrow
      ctx.font = `${Math.max(8, tileW * 0.2)}px monospace`;
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.fillText(FACING_ARROW[desk.facing] || "?", px + tileW / 2, py + tileH + 10);
    }
  }, [config, roomImg, spriteImgs, canvasW, canvasH, tileW, tileH, selectedAgentId, dragPos, pr]);

  // Mouse interaction
  const getGridPos = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvasW / rect.width;
    const scaleY = canvasH / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }, [canvasW, canvasH]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const pos = getGridPos(e);
    if (!pos) return;

    // Find clicked agent
    for (const agent of [...config.agents].reverse()) {
      const desk = config.desks.find((d) => d.id === agent.deskId);
      if (!desk) continue;
      const px = desk.gridX * tileW;
      const py = desk.gridY * tileH;
      if (pos.x >= px && pos.x <= px + tileW && pos.y >= py - tileH && pos.y <= py + tileH) {
        onSelectAgent(agent.id);
        dragRef.current = {
          deskId: desk.id,
          startX: px,
          startY: py,
          offsetX: pos.x - px,
          offsetY: pos.y - py,
        };
        return;
      }
    }
    onSelectAgent(null);
  }, [config, tileW, tileH, getGridPos, onSelectAgent]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragRef.current) return;
    const pos = getGridPos(e);
    if (!pos) return;
    setDragPos({
      x: pos.x - dragRef.current.offsetX,
      y: pos.y - dragRef.current.offsetY,
    });
  }, [getGridPos]);

  const handleMouseUp = useCallback(() => {
    if (dragRef.current && dragPos) {
      const gridX = Math.max(0, Math.min(config.grid.cols - 1, Math.round(dragPos.x / tileW)));
      const gridY = Math.max(0, Math.min(config.grid.rows - 1, Math.round(dragPos.y / tileH)));
      onMoveDesk(dragRef.current.deskId, gridX, gridY);
    }
    dragRef.current = null;
    setDragPos(null);
  }, [dragPos, tileW, tileH, config.grid, onMoveDesk]);

  return (
    <canvas
      ref={canvasRef}
      width={canvasW}
      height={canvasH}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      className="w-full h-auto cursor-crosshair"
      style={{ imageRendering: "pixelated", maxHeight: "calc(100vh - 52px)" }}
    />
  );
}

// ── Agent editor panel ───────────────────────────────────────────────────────

function AgentEditor({
  agent,
  desk,
  sprites,
  onUpdate,
  onUpdateDesk,
  onRemove,
  onSpritesChanged,
}: {
  agent: AgentConfig;
  desk: DeskConfig | undefined;
  sprites: string[];
  onUpdate: (patch: Partial<AgentConfig>) => void;
  onUpdateDesk: (patch: Partial<DeskConfig>) => void;
  onRemove: () => void;
  onSpritesChanged: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-white/10 bg-gray-900/50 p-4">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          {agent.visual?.premade && <SpriteMini file={agent.visual.premade} size={24} />}
          <div>
            <div className="text-sm font-bold text-yellow-400">{agent.name}</div>
            <div className="text-[10px] text-white/30">{agent.id}</div>
          </div>
        </div>
        <button onClick={onRemove} className="text-[10px] text-red-400/50 hover:text-red-400 transition-colors" title="Remove agent">
          remove
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Name" value={agent.name} onChange={(v) => onUpdate({ name: v })} />
        <Field label="Role" value={agent.role} onChange={(v) => onUpdate({ role: v })} />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[9px] text-white/30 mb-0.5 block">Model</label>
          <select
            value={agent.model || MODELS[1]}
            onChange={(e) => onUpdate({ model: e.target.value })}
            className="w-full rounded-md border border-white/10 bg-gray-900 px-2 py-1.5 text-[10px] text-white outline-none"
          >
            {MODELS.map((m) => <option key={m} value={m}>{m.replace("claude-", "").replace(/-\d+$/, "")}</option>)}
          </select>
        </div>
        <div>
          <label className="text-[9px] text-white/30 mb-0.5 block">Facing</label>
          <div className="flex gap-1">
            {FACING_OPTIONS.map((f) => (
              <button
                key={f}
                onClick={() => onUpdateDesk({ facing: f })}
                className={`flex-1 rounded-md py-1.5 text-[10px] transition-all ${
                  desk?.facing === f
                    ? "bg-yellow-400/15 text-yellow-400 border border-yellow-400/30"
                    : "text-white/30 border border-white/5 hover:border-white/15"
                }`}
              >
                {FACING_ARROW[f]}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div>
        <label className="text-[9px] text-white/30 mb-1 block">Sprite</label>
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {sprites.map((s) => (
            <button
              key={s}
              onClick={() => onUpdate({ visual: { premade: s } })}
              className={`flex-shrink-0 rounded-md p-0.5 transition-all ${
                agent.visual?.premade === s
                  ? "ring-2 ring-yellow-400 bg-gray-800"
                  : "bg-gray-900/60 hover:bg-gray-800 border border-white/5"
              }`}
            >
              <SpriteMini file={s} size={16} />
            </button>
          ))}
        </div>
        <div className="flex gap-1.5 mt-1.5">
          <a
            href="/sprite-maker"
            target="_blank"
            className="flex items-center gap-1 rounded-md border border-yellow-400/20 bg-yellow-400/5 px-2 py-1 text-[9px] text-yellow-400/70 hover:bg-yellow-400/10 hover:text-yellow-400 transition-all"
          >
            <svg width="8" height="8" viewBox="0 0 16 16" shapeRendering="crispEdges">
              <rect x="5" y="1" width="4" height="4" fill="currentColor" />
              <rect x="6" y="5" width="2" height="3" fill="currentColor" />
              <rect x="12" y="1" width="1" height="3" fill="currentColor" />
              <rect x="11" y="2" width="3" height="1" fill="currentColor" />
            </svg>
            Create New
          </a>
          <label className="flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[9px] text-white/30 hover:text-white/50 hover:border-white/20 transition-all cursor-pointer">
            <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 2v8M4 6l4-4 4 4" />
              <path d="M2 12h12" />
            </svg>
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
                    onUpdate({ visual: { premade } });
                    onSpritesChanged();
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

      {desk && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Grid X" value={String(desk.gridX)} onChange={(v) => onUpdateDesk({ gridX: parseInt(v) || 0 })} type="number" />
          <Field label="Grid Y" value={String(desk.gridY)} onChange={(v) => onUpdateDesk({ gridY: parseInt(v) || 0 })} type="number" />
        </div>
      )}

      <div className="flex gap-2">
        <label className="flex items-center gap-1.5 text-[10px] text-white/40">
          <input type="checkbox" checked={!!agent.isHead} onChange={(e) => onUpdate({ isHead: e.target.checked })} className="accent-yellow-400" />
          Head
        </label>
        <label className="flex items-center gap-1.5 text-[10px] text-white/40">
          <input type="checkbox" checked={!!agent.isDeptHead} onChange={(e) => onUpdate({ isDeptHead: e.target.checked })} className="accent-yellow-400" />
          Dept Head
        </label>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div>
      <label className="text-[9px] text-white/30 mb-0.5 block">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-white/10 bg-gray-900 px-2 py-1.5 text-[10px] text-white outline-none focus:border-yellow-400/40"
      />
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

export default function WorkspaceBuilderPage() {
  const [allConfigs, setAllConfigs] = useState<Record<string, OfficeConfig> | null>(null);
  const [activeSlug, setActiveSlug] = useState<string>("");
  const [config, setConfig] = useState<OfficeConfig | null>(null);
  const [sprites, setSprites] = useState<string[]>([]);
  const [rooms, setRooms] = useState<Record<string, string[]>>({});
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [dirty, setDirty] = useState(false);

  // Load data
  useEffect(() => {
    Promise.all([
      fetch("/api/workspace-builder/configs").then((r) => r.json()),
      fetch("/api/workspace-builder/sprites").then((r) => r.json()),
      fetch("/api/workspace-builder/rooms").then((r) => r.json()),
    ]).then(([configs, spriteData, roomData]) => {
      setAllConfigs(configs);
      setSprites(spriteData.sprites || []);
      setRooms(roomData.grouped || {});
      const slugs = Object.keys(configs);
      if (slugs.length > 0) {
        setActiveSlug(slugs[0]);
        setConfig(structuredClone(configs[slugs[0]]));
      }
    }).catch(console.error);
  }, []);

  // Switch office
  const switchOffice = useCallback((slug: string) => {
    if (dirty && !confirm("Unsaved changes. Switch anyway?")) return;
    setActiveSlug(slug);
    setConfig(allConfigs ? structuredClone(allConfigs[slug]) : null);
    setSelectedAgentId(null);
    setDirty(false);
  }, [allConfigs, dirty]);

  // Create new office
  const createNewOffice = useCallback(() => {
    const name = prompt("Office name:");
    if (!name?.trim()) return;
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!slug) return;
    if (allConfigs && allConfigs[slug]) {
      alert("An office with that slug already exists.");
      return;
    }
    if (dirty && !confirm("Unsaved changes. Continue?")) return;

    const newConfig: OfficeConfig = {
      slug,
      name: name.trim(),
      theme: {
        floor: "#303034",
        floorAlt: "#3c3c42",
        wall: "#18181c",
        deskTop: "#4a4a50",
        deskSide: "#303034",
        accent: "#5aa0ff",
        highlight: "#88bbff",
        bg: "#1a2030",
      },
      tile: { w: 32, h: 32 },
      grid: { cols: 20, rows: 14 },
      rooms: [{ id: "main", name: "Main", gridX: 1, gridY: 1, w: 8, h: 6 }],
      desks: [],
      agents: [],
    };

    setAllConfigs((prev) => prev ? { ...prev, [slug]: structuredClone(newConfig) } : { [slug]: structuredClone(newConfig) });
    setActiveSlug(slug);
    setConfig(newConfig);
    setSelectedAgentId(null);
    setDirty(true);
  }, [allConfigs, dirty]);

  // Mutate config helpers
  const updateConfig = useCallback((fn: (c: OfficeConfig) => void) => {
    setConfig((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      fn(next);
      setDirty(true);
      return next;
    });
  }, []);

  const updateAgent = useCallback((agentId: string, patch: Partial<AgentConfig>) => {
    updateConfig((c) => {
      const agent = c.agents.find((a) => a.id === agentId);
      if (agent) Object.assign(agent, patch);
    });
  }, [updateConfig]);

  const updateDesk = useCallback((deskId: string, patch: Partial<DeskConfig>) => {
    updateConfig((c) => {
      const desk = c.desks.find((d) => d.id === deskId);
      if (desk) Object.assign(desk, patch);
    });
  }, [updateConfig]);

  const moveDesk = useCallback((deskId: string, gridX: number, gridY: number) => {
    updateConfig((c) => {
      const desk = c.desks.find((d) => d.id === deskId);
      if (desk) { desk.gridX = gridX; desk.gridY = gridY; }
    });
  }, [updateConfig]);

  const removeAgent = useCallback((agentId: string) => {
    if (!confirm("Remove this agent?")) return;
    updateConfig((c) => {
      const agent = c.agents.find((a) => a.id === agentId);
      if (agent) {
        c.agents = c.agents.filter((a) => a.id !== agentId);
        c.desks = c.desks.filter((d) => d.id !== agent.deskId);
      }
    });
    setSelectedAgentId(null);
  }, [updateConfig]);

  const addAgent = useCallback(() => {
    updateConfig((c) => {
      const id = `agent-${Date.now()}`;
      const deskId = `desk-${id}`;
      c.desks.push({ id: deskId, roomId: c.rooms[0]?.id || "", gridX: 5, gridY: 5, facing: "S" });
      c.agents.push({
        id,
        deskId,
        name: "New Agent",
        role: "Role",
        spritePack: "limezu/office/auto",
        visual: { premade: sprites[0] || "premade_02.png" },
        isReal: true,
        cwd: `agent-workspaces/${activeSlug}/${id}`,
        allowedTools: ["Read", "Edit", "Write", "Grep", "Glob", "Bash", "WebSearch", "WebFetch"],
        model: MODELS[1],
      });
      setSelectedAgentId(id);
    });
  }, [updateConfig, sprites, activeSlug]);

  // Refresh sprite list (after import)
  const refreshSprites = useCallback(() => {
    fetch("/api/workspace-builder/sprites")
      .then((r) => r.json())
      .then((data) => setSprites(data.sprites || []))
      .catch(console.error);
  }, []);

  // Room switcher
  const switchRoom = useCallback((layerFile: string) => {
    // Need to figure out dimensions from the image
    loadImg(`/sprites/interiors/premade_rooms/${layerFile}`).then((img) => {
      updateConfig((c) => {
        c.theme.premadeRoom = {
          layers: [layerFile],
          pixelWidth: img.width,
          pixelHeight: img.height,
          sourceTileSize: 16,
          characterDepthIndex: 1,
        };
        // Recalculate grid
        const scale = c.tile.w / 16;
        c.grid.cols = Math.ceil(img.width / 16);
        c.grid.rows = Math.ceil(img.height / 16);
      });
    }).catch(console.error);
  }, [updateConfig]);

  // Save
  const save = useCallback(async () => {
    if (!config || !activeSlug) return;
    setSaveStatus("saving");
    try {
      const res = await fetch("/api/workspace-builder/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: activeSlug, config }),
      });
      if (!res.ok) throw new Error(await res.text());
      setSaveStatus("saved");
      setDirty(false);
      // Update allConfigs
      setAllConfigs((prev) => prev ? { ...prev, [activeSlug]: structuredClone(config) } : prev);
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch {
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
    }
  }, [config, activeSlug]);

  const selectedAgent = config?.agents.find((a) => a.id === selectedAgentId);
  const selectedDesk = selectedAgent ? config?.desks.find((d) => d.id === selectedAgent.deskId) : undefined;

  if (!allConfigs || !config) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-950 text-white/30">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/10 border-t-blue-400" />
          <span className="font-mono text-xs">loading configs...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-gray-950 font-mono text-white">
      {/* ── LEFT: Room preview ──────────────────────────────────────── */}
      <div className="flex flex-1 flex-col overflow-hidden border-r border-white/10">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
          <div className="flex items-center gap-3">
            <svg width="16" height="16" viewBox="0 0 16 16" shapeRendering="crispEdges">
              <rect x="2" y="5" width="12" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
              <polygon points="8,1 14,5 2,5" fill="none" stroke="currentColor" strokeWidth="1" />
              <rect x="6" y="9" width="4" height="5" fill="currentColor" opacity="0.3" />
              <rect x="3" y="7" width="2" height="2" fill="#facc15" />
              <rect x="11" y="7" width="2" height="2" fill="#facc15" />
            </svg>
            <span className="text-sm font-bold tracking-wide">Workspace Builder</span>
          </div>
          <div className="flex items-center gap-3">
            {dirty && <span className="text-[9px] text-yellow-400/60">unsaved</span>}
            <button
              onClick={save}
              disabled={!dirty || saveStatus === "saving"}
              className={`rounded-md px-3 py-1.5 text-[10px] font-bold transition-all disabled:opacity-30 ${
                saveStatus === "saved"
                  ? "bg-green-500/20 text-green-400 border border-green-500/30"
                  : saveStatus === "error"
                  ? "bg-red-500/20 text-red-400 border border-red-500/30"
                  : "bg-blue-500/20 text-blue-400 border border-blue-500/30 hover:bg-blue-500/30"
              }`}
            >
              {saveStatus === "saving" ? "..." : saveStatus === "saved" ? "Saved!" : saveStatus === "error" ? "Error" : "Save"}
            </button>
            <a href="/" className="text-[10px] text-white/30 hover:text-white/60 transition-colors">back</a>
          </div>
        </div>

        {/* Office tabs */}
        <div className="flex border-b border-white/10">
          {Object.entries(allConfigs).map(([slug, cfg]) => (
            <button
              key={slug}
              onClick={() => switchOffice(slug)}
              className={`relative flex-1 px-3 py-2 text-[11px] transition-all ${
                activeSlug === slug
                  ? "bg-gray-900 text-white"
                  : "text-white/30 hover:text-white/60 hover:bg-gray-900/50"
              }`}
            >
              {(cfg as OfficeConfig).name}
              {activeSlug === slug && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-400" />}
            </button>
          ))}
          <button
            onClick={createNewOffice}
            className="flex-shrink-0 px-4 py-2 text-[11px] text-white/20 hover:text-white/50 hover:bg-gray-900/50 transition-all border-l border-white/5"
            title="Create new office"
          >
            +
          </button>
        </div>

        {/* Room canvas */}
        <div className="flex-1 overflow-auto p-4 flex items-center justify-center bg-gray-950">
          <div className="inline-block rounded-lg overflow-hidden border border-white/10 shadow-2xl">
            <RoomCanvas
              config={config}
              selectedAgentId={selectedAgentId}
              onSelectAgent={setSelectedAgentId}
              onMoveDesk={moveDesk}
            />
          </div>
        </div>
      </div>

      {/* ── RIGHT: Config panel ─────────────────────────────────────── */}
      <div className="flex w-[380px] flex-shrink-0 flex-col overflow-hidden">
        {/* Office name */}
        <div className="border-b border-white/10 px-4 py-3">
          <div className="text-[9px] text-white/30 mb-1">Office Name</div>
          <input
            type="text"
            value={config.name}
            onChange={(e) => updateConfig((c) => { c.name = e.target.value; })}
            className="w-full rounded-md border border-white/10 bg-gray-900 px-2 py-1.5 text-[11px] text-white font-bold outline-none focus:border-blue-400/40"
          />
          <div className="text-[8px] text-white/15 mt-1">slug: {config.slug}</div>
        </div>

        {/* Room picker */}
        <div className="border-b border-white/10 px-4 py-3">
          <div className="text-[9px] text-white/30 mb-2">Room Background</div>
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {Object.entries(rooms).map(([brand, files]) =>
              files.filter((f) => f.includes("layer1")).map((f) => (
                <button
                  key={f}
                  onClick={() => switchRoom(f)}
                  className={`flex-shrink-0 rounded-md text-[8px] px-2 py-1 transition-all ${
                    config.theme.premadeRoom?.layers?.[0] === f
                      ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                      : "text-white/30 border border-white/5 hover:border-white/20"
                  }`}
                  title={f}
                >
                  {f.replace(/_layer1\.png$/, "").replace(/_/g, " ")}
                </button>
              ))
            )}
          </div>
        </div>

        {/* Grid settings */}
        <div className="border-b border-white/10 px-4 py-3">
          <div className="text-[9px] text-white/30 mb-2">Grid</div>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Cols" value={String(config.grid.cols)} onChange={(v) => updateConfig((c) => { c.grid.cols = parseInt(v) || 1; })} type="number" />
            <Field label="Rows" value={String(config.grid.rows)} onChange={(v) => updateConfig((c) => { c.grid.rows = parseInt(v) || 1; })} type="number" />
            <Field label="Tile" value={String(config.tile.w)} onChange={(v) => updateConfig((c) => { c.tile.w = c.tile.h = parseInt(v) || 16; })} type="number" />
          </div>
        </div>

        {/* Agent list + editor */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[9px] text-white/30">Agents ({config.agents.length})</div>
            <button
              onClick={addAgent}
              className="rounded-md border border-white/10 px-2 py-1 text-[9px] text-white/40 hover:text-white/70 hover:border-white/25 transition-all"
            >
              + Add Agent
            </button>
          </div>

          {/* Selected agent editor */}
          {selectedAgent && (
            <div className="mb-4">
              <AgentEditor
                agent={selectedAgent}
                desk={selectedDesk}
                sprites={sprites}
                onUpdate={(patch) => updateAgent(selectedAgent.id, patch)}
                onUpdateDesk={(patch) => selectedDesk && updateDesk(selectedDesk.id, patch)}
                onRemove={() => removeAgent(selectedAgent.id)}
                onSpritesChanged={refreshSprites}
              />
            </div>
          )}

          {/* Agent list */}
          <div className="flex flex-col gap-1">
            {config.agents.map((agent) => {
              const desk = config.desks.find((d) => d.id === agent.deskId);
              const isSelected = selectedAgentId === agent.id;
              return (
                <button
                  key={agent.id}
                  onClick={() => setSelectedAgentId(isSelected ? null : agent.id)}
                  className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-left transition-all ${
                    isSelected
                      ? "bg-yellow-400/10 border border-yellow-400/30"
                      : "border border-transparent hover:bg-gray-900/80 hover:border-white/5"
                  }`}
                >
                  {agent.visual?.premade && <SpriteMini file={agent.visual.premade} size={12} />}
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-bold truncate">{agent.name}</div>
                    <div className="text-[9px] text-white/30 truncate">{agent.role}</div>
                  </div>
                  <div className="flex flex-col items-end gap-0.5">
                    <span className="text-[8px] text-white/20">
                      {(agent.model || "sonnet").includes("opus") ? "opus" : "sonnet"}
                    </span>
                    {desk && (
                      <span className="text-[8px] text-white/15">
                        {desk.gridX},{desk.gridY} {FACING_ARROW[desk.facing]}
                      </span>
                    )}
                  </div>
                  {agent.isHead && <span className="text-[7px] text-yellow-400/60 font-bold">HEAD</span>}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
