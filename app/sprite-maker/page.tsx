"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

type AssetList = {
  bodies: string[];
  eyes: string[];
  outfits: string[];
  hairstyles: string[];
  accessories: string[];
};

type Selection = {
  body: string;
  eyes: string;
  outfit: string;
  hairstyle: string;
  accessory: string;
};

type LayerKey = keyof Selection;

// ── Constants ─────────────────────────────────────────────────────────────────

const SHEET_W = 896;
const SHEET_H = 656;
const BODY_W = 927;
const TILE = 16;

// Character frame: 16px wide × 32px tall (2 tile-rows)
const CHAR_W = 16;
const CHAR_H = 32;

// Row-pair offsets (each row-pair = 32px)
const IDLE_PAIR_Y = 32;  // row-pair 1 = idle

// Pose row-pairs (y = rowPair * 32)
const POSES = [
  { key: "idle", label: "Idle", rowPair: 1 },
  { key: "walk", label: "Walk", rowPair: 2 },
  { key: "sit", label: "Sit", rowPair: 8 },
  { key: "phone", label: "Phone", rowPair: 9 },
  { key: "sleep", label: "Sleep", rowPair: 10 },
  { key: "item", label: "Hold", rowPair: 11 },
] as const;
type PoseKey = (typeof POSES)[number]["key"];

const BG_PRESETS = [
  { label: "Check", value: "checker" },
  { label: "Black", value: "#000000" },
  { label: "White", value: "#ffffff" },
  { label: "Green", value: "#2d5a27" },
  { label: "Blue", value: "#1a2a4a" },
  { label: "Pink", value: "#3a1a2a" },
] as const;

// Direction column offsets within a 24-column animation group
const DIR_OFFSETS = { S: 18, N: 6, W: 12, E: 0 } as const;
type Dir = keyof typeof DIR_OFFSETS;
const DIR_LABELS: Record<Dir, string> = { S: "Front", E: "Right", N: "Back", W: "Left" };
const PREVIEW_DIRS: Dir[] = ["S", "E", "N", "W"];

// LimeZu idle has 6 frames but frame 5 is a squished transition frame.
// Use first 4 for a clean loop in the preview.
const FRAMES_PER_DIR = 4;
const PREVIEW_SCALE = 6;
const FPS = 3;

const LAYER_ORDER: { key: LayerKey; label: string; folder: string }[] = [
  { key: "body", label: "Body", folder: "bodies" },
  { key: "eyes", label: "Eyes", folder: "eyes" },
  { key: "outfit", label: "Outfit", folder: "outfits" },
  { key: "hairstyle", label: "Hair", folder: "hairstyles" },
  { key: "accessory", label: "Accessory", folder: "accessories" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const imageCache = new Map<string, HTMLImageElement>();

function loadImage(src: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(src);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { imageCache.set(src, img); resolve(img); };
    img.onerror = reject;
    img.src = src;
  });
}

function getGroup(filename: string): string {
  return filename.split("_")[1] ?? "00";
}

function getAccessoryName(filename: string): string {
  const parts = filename.replace(".png", "").split("_");
  return parts.slice(2, -1).join(" ") || "Unknown";
}

function buildGroups(
  files: string[],
  labelFn: (gk: string, f: string) => string,
): { key: string; label: string; files: string[] }[] {
  const map = new Map<string, { label: string; files: string[] }>();
  for (const f of files) {
    const gk = getGroup(f);
    if (!map.has(gk)) map.set(gk, { label: labelFn(gk, f), files: [] });
    map.get(gk)!.files.push(f);
  }
  return Array.from(map.entries()).map(([key, val]) => ({ key, ...val }));
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ── Compositing ───────────────────────────────────────────────────────────────

const BASE = "/sprites/characters/generator";

async function compositeSheet(sel: Selection): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  canvas.width = SHEET_W;
  canvas.height = SHEET_H;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;

  const bodyImg = await loadImage(`${BASE}/bodies/${sel.body}`);
  ctx.drawImage(bodyImg, -TILE, 0);

  const eyesImg = await loadImage(`${BASE}/eyes/${sel.eyes}`);
  ctx.drawImage(eyesImg, 0, 0);

  const outfitImg = await loadImage(`${BASE}/outfits/${sel.outfit}`);
  ctx.drawImage(outfitImg, 0, 0);

  const hairImg = await loadImage(`${BASE}/hairstyles/${sel.hairstyle}`);
  ctx.drawImage(hairImg, 0, 0);

  if (sel.accessory) {
    const accImg = await loadImage(`${BASE}/accessories/${sel.accessory}`);
    ctx.drawImage(accImg, 0, 0);
  }

  return canvas;
}

/** Composite a single layer onto the current body for thumbnail preview */
async function compositeThumb(
  bodyFile: string,
  layerKey: LayerKey,
  layerFile: string,
  folder: string,
): Promise<HTMLCanvasElement> {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size * 2;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;

  const dir = DIR_OFFSETS.S;

  // Always draw body first (except when previewing bodies themselves)
  if (layerKey !== "body") {
    const bodyImg = await loadImage(`${BASE}/bodies/${bodyFile}`);
    // Body source x needs +1 tile offset for the wider sheet
    const bodySx = (dir + 1) * TILE;
    ctx.drawImage(bodyImg, bodySx, IDLE_PAIR_Y, CHAR_W, CHAR_H, 0, 0, size, size * 2);
  }

  // Draw the layer
  const layerImg = await loadImage(`${BASE}/${folder}/${layerFile}`);
  const isBody = layerKey === "body";
  const sx = (dir + (isBody ? 1 : 0)) * TILE;
  ctx.drawImage(layerImg, sx, IDLE_PAIR_Y, CHAR_W, CHAR_H, 0, 0, size, size * 2);

  return canvas;
}

// ── Thumbnail with body composite ─────────────────────────────────────────────

function Thumb({
  bodyFile,
  layerKey,
  layerFile,
  folder,
  selected,
  onClick,
  label,
}: {
  bodyFile: string;
  layerKey: LayerKey;
  layerFile: string;
  folder: string;
  selected: boolean;
  onClick: () => void;
  label?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    compositeThumb(bodyFile, layerKey, layerFile, folder).then((result) => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(result, 0, 0);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [bodyFile, layerKey, layerFile, folder]);

  return (
    <button
      onClick={onClick}
      title={label}
      className={`relative flex-shrink-0 rounded-lg transition-all ${
        selected
          ? "ring-2 ring-yellow-400 ring-offset-2 ring-offset-gray-950 bg-gray-800 scale-105"
          : "bg-gray-900/60 hover:bg-gray-800 border border-white/5 hover:border-white/20"
      }`}
      style={{ width: 72, height: 136 }}
    >
      <canvas
        ref={canvasRef}
        width={64}
        height={128}
        className="absolute left-1 top-1"
        style={{ imageRendering: "pixelated", width: 64, height: 128 }}
      />
    </button>
  );
}

// ── Checkerboard CSS ──────────────────────────────────────────────────────────

const checkerStyle: React.CSSProperties = {
  backgroundImage: `
    linear-gradient(45deg, #1a1a2e 25%, transparent 25%),
    linear-gradient(-45deg, #1a1a2e 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #1a1a2e 75%),
    linear-gradient(-45deg, transparent 75%, #1a1a2e 75%)
  `,
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
  backgroundColor: "#12122a",
};

// ── Main ──────────────────────────────────────────────────────────────────────

type AgentOption = { id: string; name: string; role: string; office: string; slug: string; premade: string };

export default function SpriteMakerPage() {
  const [assets, setAssets] = useState<AssetList | null>(null);
  const [sel, setSel] = useState<Selection>({
    body: "", eyes: "", outfit: "", hairstyle: "", accessory: "",
  });
  const [activeLayer, setActiveLayer] = useState<LayerKey>("body");
  const [activeGroup, setActiveGroup] = useState<string>("");
  const [sheet, setSheet] = useState<HTMLCanvasElement | null>(null);
  const [compositing, setCompositing] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [allAgents, setAllAgents] = useState<AgentOption[]>([]);
  const [assignTarget, setAssignTarget] = useState("");
  const [assignStatus, setAssignStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [pose, setPose] = useState<PoseKey>("idle");
  const [bgColor, setBgColor] = useState<string>("checker");
  const [hue, setHue] = useState(0);
  const [saturation, setSaturation] = useState(100);
  const [brightness, setBrightness] = useState(100);
  const [previewScale, setPreviewScale] = useState(PREVIEW_SCALE);
  const [nameTag, setNameTag] = useState("");

  // 4 preview canvases (S, E, N, W) — animated imperatively via rAF, no React state for frame
  const previewRefs = useRef<(HTMLCanvasElement | null)[]>([null, null, null, null]);
  const sheetRef = useRef<HTMLCanvasElement | null>(null);
  const poseRef = useRef(pose);
  const scaleRef = useRef(previewScale);
  poseRef.current = pose;
  scaleRef.current = previewScale;

  // Load assets + agent list
  useEffect(() => {
    fetch("/api/sprite-maker/list")
      .then((r) => r.json())
      .then((data: AssetList) => {
        setAssets(data);
        setSel({
          body: data.bodies[0] ?? "",
          eyes: data.eyes[0] ?? "",
          outfit: data.outfits[0] ?? "",
          hairstyle: data.hairstyles[0] ?? "",
          accessory: "",
        });
      })
      .catch(console.error);

    // Load all agents from all offices
    fetch("/api/workspace-builder/configs")
      .then((r) => r.json())
      .then((configs: Record<string, { slug: string; name: string; agents: Array<{ id: string; name: string; role: string; visual?: { premade: string } }> }>) => {
        const agents: AgentOption[] = [];
        for (const [slug, cfg] of Object.entries(configs)) {
          for (const a of cfg.agents || []) {
            agents.push({ id: a.id, name: a.name, role: a.role, office: cfg.name, slug, premade: a.visual?.premade || "" });
          }
        }
        setAllAgents(agents);
      })
      .catch(console.error);
  }, []);

  // Re-composite on selection change
  useEffect(() => {
    if (!sel.body || !sel.eyes || !sel.outfit || !sel.hairstyle) return;
    let cancelled = false;
    setCompositing(true);
    compositeSheet(sel).then((canvas) => {
      if (!cancelled) {
        setSheet(canvas);
        sheetRef.current = canvas;
        setCompositing(false);
      }
    }).catch(() => { if (!cancelled) setCompositing(false); });
    return () => { cancelled = true; };
  }, [sel]);

  // Imperative animation loop — no React state for frame counter, no flicker
  useEffect(() => {
    let frameIdx = 0;
    let lastFrameTime = 0;
    let rafId: number;
    const frameInterval = 1000 / FPS;

    const tick = (now: number) => {
      rafId = requestAnimationFrame(tick);
      if (now - lastFrameTime < frameInterval) return;
      lastFrameTime = now;

      const s = sheetRef.current;
      if (!s) return;

      frameIdx = (frameIdx + 1) % FRAMES_PER_DIR;

      const poseInfo = POSES.find((p) => p.key === poseRef.current) ?? POSES[0];
      const pairY = poseInfo.rowPair * 32;
      const sc = scaleRef.current;

      for (let i = 0; i < PREVIEW_DIRS.length; i++) {
        const canvas = previewRefs.current[i];
        if (!canvas) continue;
        // Resize canvas if scale changed
        if (canvas.width !== CHAR_W * sc) canvas.width = CHAR_W * sc;
        if (canvas.height !== CHAR_H * sc) canvas.height = CHAR_H * sc;
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const sx = (DIR_OFFSETS[PREVIEW_DIRS[i]] + frameIdx) * TILE;
        ctx.drawImage(s, sx, pairY, CHAR_W, CHAR_H, 0, 0, CHAR_W * sc, CHAR_H * sc);
      }
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const exportPNG = useCallback(() => {
    if (!sheet) return;
    const a = document.createElement("a");
    a.download = `character_${Date.now()}.png`;
    a.href = sheet.toDataURL("image/png");
    a.click();
  }, [sheet]);

  const saveSprite = useCallback(async () => {
    if (!sheet || !saveName.trim()) return;
    setSaveStatus("saving");
    try {
      const imageData = sheet.toDataURL("image/png");
      const res = await fetch("/api/sprite-maker/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: saveName.trim(), imageData }),
      });
      if (!res.ok) throw new Error(await res.text());
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 3000);
    } catch {
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
    }
  }, [sheet, saveName]);

  // Save sprite and assign to an existing agent
  const assignToAgent = useCallback(async () => {
    if (!sheet || !assignTarget) return;
    const agent = allAgents.find((a) => `${a.slug}/${a.id}` === assignTarget);
    if (!agent) return;

    setAssignStatus("saving");
    try {
      // Save the sprite with the agent's name
      const spriteName = agent.name;
      const imageData = sheet.toDataURL("image/png");
      const saveRes = await fetch("/api/sprite-maker/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: spriteName, imageData }),
      });
      if (!saveRes.ok) throw new Error(await saveRes.text());

      // Load the office config, update the agent's visual, save it back
      const configsRes = await fetch("/api/workspace-builder/configs");
      const configs = await configsRes.json();
      const officeConfig = configs[agent.slug];
      if (!officeConfig) throw new Error("Office config not found");

      const agentConfig = officeConfig.agents.find((a: { id: string }) => a.id === agent.id);
      if (!agentConfig) throw new Error("Agent not found in config");

      agentConfig.visual = { premade: `premade_${spriteName.replace(/[^a-zA-Z0-9_-]/g, "_")}.png` };

      const updateRes = await fetch("/api/workspace-builder/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: agent.slug, config: officeConfig }),
      });
      if (!updateRes.ok) throw new Error(await updateRes.text());

      setAssignStatus("saved");
      setTimeout(() => setAssignStatus("idle"), 3000);
    } catch {
      setAssignStatus("error");
      setTimeout(() => setAssignStatus("idle"), 3000);
    }
  }, [sheet, assignTarget, allAgents]);

  const randomize = useCallback(() => {
    if (!assets) return;
    setSel({
      body: pickRandom(assets.bodies),
      eyes: pickRandom(assets.eyes),
      outfit: pickRandom(assets.outfits),
      hairstyle: pickRandom(assets.hairstyles),
      accessory: Math.random() > 0.5 ? pickRandom(assets.accessories) : "",
    });
  }, [assets]);

  // Build groups for active layer
  const layerInfo = LAYER_ORDER.find((l) => l.key === activeLayer)!;
  const layerFiles = useMemo(() => {
    if (!assets) return [];
    const map: Record<string, string[]> = {
      body: assets.bodies, eyes: assets.eyes, outfit: assets.outfits,
      hairstyle: assets.hairstyles, accessory: assets.accessories,
    };
    return map[activeLayer] ?? [];
  }, [assets, activeLayer]);

  const isSimple = activeLayer === "body" || activeLayer === "eyes";
  const isAccessory = activeLayer === "accessory";

  const groups = useMemo(() => {
    if (isSimple) return [{ key: "all", label: "All", files: layerFiles }];
    if (isAccessory) return buildGroups(layerFiles, (_gk, f) => getAccessoryName(f));
    return buildGroups(layerFiles, (gk) => `Style ${gk}`);
  }, [layerFiles, isSimple, isAccessory]);

  const currentGroupKey = activeGroup && groups.some((g) => g.key === activeGroup) ? activeGroup : groups[0]?.key ?? "";
  const currentGroup = groups.find((g) => g.key === currentGroupKey);
  const currentFiles = currentGroup?.files ?? [];

  if (!assets) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-950 text-white/30">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/10 border-t-yellow-400" />
          <span className="font-mono text-xs">loading assets...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-gray-950 font-mono text-white">
      {/* ── LEFT: Fixed preview panel ──────────────────────────────── */}
      <div className="flex w-[420px] flex-shrink-0 flex-col border-r border-white/10">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 16 16" shapeRendering="crispEdges">
              <rect x="5" y="1" width="4" height="4" fill="currentColor" />
              <rect x="6" y="5" width="2" height="3" fill="currentColor" />
              <rect x="4" y="6" width="2" height="1" fill="currentColor" />
              <rect x="8" y="6" width="2" height="1" fill="currentColor" />
              <rect x="5" y="8" width="2" height="3" fill="currentColor" />
              <rect x="7" y="8" width="2" height="3" fill="currentColor" />
              <rect x="12" y="1" width="1" height="3" fill="#facc15" />
              <rect x="11" y="2" width="3" height="1" fill="#facc15" />
            </svg>
            <span className="text-sm font-bold tracking-wide">Sprite Maker</span>
          </div>
          <a href="/" className="text-[10px] text-white/30 hover:text-white/60 transition-colors">back</a>
        </div>

        {/* 4-direction preview */}
        <div className="flex flex-col items-center gap-4 px-6 pt-4">
          <div
            className="relative rounded-xl p-4"
            style={bgColor === "checker" ? checkerStyle : { backgroundColor: bgColor }}
          >
            {compositing && (
              <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-gray-950/60 backdrop-blur-sm">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/10 border-t-yellow-400" />
              </div>
            )}
            <div
              className="flex items-end gap-3"
              style={{
                filter: `hue-rotate(${hue}deg) saturate(${saturation}%) brightness(${brightness}%)`,
              }}
            >
              {PREVIEW_DIRS.map((dir, i) => (
                <div key={dir} className="flex flex-col items-center gap-1">
                  {nameTag && (
                    <div className="mb-1 rounded-full bg-gray-900/80 px-2 py-0.5 text-[7px] font-bold text-white/80 border border-white/10 whitespace-nowrap">
                      {nameTag}
                    </div>
                  )}
                  <canvas
                    ref={(el) => { previewRefs.current[i] = el; }}
                    width={CHAR_W * previewScale}
                    height={CHAR_H * previewScale}
                    style={{ imageRendering: "pixelated", width: CHAR_W * previewScale, height: CHAR_H * previewScale }}
                  />
                  <span className="text-[8px] text-white/30">{DIR_LABELS[dir]}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Pose selector */}
          <div className="flex w-full flex-wrap gap-1">
            {POSES.map((p) => (
              <button
                key={p.key}
                onClick={() => setPose(p.key)}
                className={`flex-1 rounded-md px-2 py-1.5 text-[10px] transition-all ${
                  pose === p.key
                    ? "bg-yellow-400/15 text-yellow-400 border border-yellow-400/30"
                    : "text-white/30 hover:text-white/50 border border-white/5 hover:border-white/15"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Background presets */}
          <div className="flex w-full items-center gap-2">
            <span className="text-[9px] text-white/20 w-6">BG</span>
            <div className="flex gap-1.5">
              {BG_PRESETS.map((bg) => (
                <button
                  key={bg.value}
                  onClick={() => setBgColor(bg.value)}
                  title={bg.label}
                  className={`h-5 w-5 rounded-md border transition-all ${
                    bgColor === bg.value ? "border-yellow-400 scale-110" : "border-white/10 hover:border-white/30"
                  }`}
                  style={bg.value === "checker"
                    ? { ...checkerStyle, backgroundSize: "6px 6px", backgroundPosition: "0 0, 0 3px, 3px -3px, -3px 0px" }
                    : { backgroundColor: bg.value }
                  }
                />
              ))}
              <input
                type="color"
                value={bgColor.startsWith("#") ? bgColor : "#12122a"}
                onChange={(e) => setBgColor(e.target.value)}
                className="h-5 w-5 cursor-pointer rounded-md border border-white/10 bg-transparent"
                title="Custom color"
              />
            </div>
          </div>

          {/* Sliders */}
          <div className="flex w-full flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-white/20 w-6">Hue</span>
              <input type="range" min={-180} max={180} value={hue} onChange={(e) => setHue(+e.target.value)}
                className="flex-1 h-1 accent-yellow-400" />
              <span className="text-[9px] text-white/30 w-8 text-right">{hue}°</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-white/20 w-6">Sat</span>
              <input type="range" min={0} max={200} value={saturation} onChange={(e) => setSaturation(+e.target.value)}
                className="flex-1 h-1 accent-yellow-400" />
              <span className="text-[9px] text-white/30 w-8 text-right">{saturation}%</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-white/20 w-6">Lum</span>
              <input type="range" min={50} max={150} value={brightness} onChange={(e) => setBrightness(+e.target.value)}
                className="flex-1 h-1 accent-yellow-400" />
              <span className="text-[9px] text-white/30 w-8 text-right">{brightness}%</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-white/20 w-6">Zoom</span>
              <input type="range" min={3} max={10} value={previewScale} onChange={(e) => setPreviewScale(+e.target.value)}
                className="flex-1 h-1 accent-yellow-400" />
              <span className="text-[9px] text-white/30 w-8 text-right">{previewScale}x</span>
            </div>
            {(hue !== 0 || saturation !== 100 || brightness !== 100) && (
              <button
                onClick={() => { setHue(0); setSaturation(100); setBrightness(100); }}
                className="self-end text-[9px] text-white/20 hover:text-white/50 transition-colors"
              >
                reset colors
              </button>
            )}
          </div>

          {/* Name tag preview */}
          <div className="flex w-full items-center gap-2">
            <span className="text-[9px] text-white/20 w-6">Tag</span>
            <input
              type="text"
              value={nameTag}
              onChange={(e) => setNameTag(e.target.value)}
              placeholder="name tag..."
              className="flex-1 rounded-md border border-white/10 bg-gray-900 px-2 py-1.5 text-[10px] text-white outline-none placeholder:text-white/15 focus:border-yellow-400/40"
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-3 px-6 pt-5">
          <button
            onClick={randomize}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-gray-900 py-2.5 text-xs transition-all hover:border-yellow-400/40 hover:bg-gray-800 active:scale-[0.98]"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
            </svg>
            Randomize
          </button>

          <button
            onClick={exportPNG}
            disabled={!sheet}
            className="w-full rounded-lg border border-white/10 bg-gray-900 py-2.5 text-xs transition-all hover:border-white/25 hover:bg-gray-800 disabled:opacity-30"
          >
            Download Full Sheet (896x656)
          </button>

          <div className="flex gap-2">
            <input
              type="text"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="agent name..."
              className="flex-1 rounded-lg border border-white/10 bg-gray-900 px-3 py-2.5 text-xs text-white outline-none placeholder:text-white/20 focus:border-yellow-400/40"
            />
            <button
              onClick={saveSprite}
              disabled={!sheet || !saveName.trim() || saveStatus === "saving"}
              className={`rounded-lg border px-4 py-2.5 text-xs transition-all disabled:opacity-30 ${
                saveStatus === "saved"
                  ? "border-green-500/40 text-green-400 bg-green-500/5"
                  : saveStatus === "error"
                  ? "border-red-500/40 text-red-400"
                  : "border-white/10 bg-gray-900 hover:border-white/25 hover:bg-gray-800"
              }`}
            >
              {saveStatus === "saving" ? "..." : saveStatus === "saved" ? "Saved!" : saveStatus === "error" ? "Error" : "Save"}
            </button>
          </div>
          {saveStatus === "saved" && (
            <div className="text-center text-[10px] text-green-400/60">
              premade_{saveName.replace(/[^a-zA-Z0-9_-]/g, "_")}.png
            </div>
          )}

          {/* Assign to agent */}
          {allAgents.length > 0 && (
            <div className="mt-1 rounded-lg border border-white/5 bg-gray-900/30 p-3">
              <div className="text-[9px] text-white/30 mb-1.5">Assign to Agent</div>
              <div className="flex gap-2">
                <select
                  value={assignTarget}
                  onChange={(e) => setAssignTarget(e.target.value)}
                  className="flex-1 rounded-lg border border-white/10 bg-gray-900 px-2 py-2 text-[10px] text-white outline-none focus:border-yellow-400/40"
                >
                  <option value="">select agent...</option>
                  {Object.entries(
                    allAgents.reduce<Record<string, AgentOption[]>>((acc, a) => {
                      (acc[a.office] ??= []).push(a);
                      return acc;
                    }, {})
                  ).map(([office, agents]) => (
                    <optgroup key={office} label={office}>
                      {agents.map((a) => (
                        <option key={`${a.slug}/${a.id}`} value={`${a.slug}/${a.id}`}>
                          {a.name} — {a.role}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <button
                  onClick={assignToAgent}
                  disabled={!sheet || !assignTarget || assignStatus === "saving"}
                  className={`rounded-lg border px-3 py-2 text-[10px] font-bold transition-all disabled:opacity-30 ${
                    assignStatus === "saved"
                      ? "border-green-500/40 text-green-400 bg-green-500/5"
                      : assignStatus === "error"
                      ? "border-red-500/40 text-red-400"
                      : "border-yellow-400/30 bg-yellow-400/10 text-yellow-400 hover:bg-yellow-400/20"
                  }`}
                >
                  {assignStatus === "saving" ? "..." : assignStatus === "saved" ? "Done!" : assignStatus === "error" ? "Error" : "Assign"}
                </button>
              </div>
              {assignStatus === "saved" && assignTarget && (
                <div className="text-center text-[10px] text-green-400/60 mt-1">
                  Sprite assigned to {allAgents.find((a) => `${a.slug}/${a.id}` === assignTarget)?.name}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Current selection summary */}
        <div className="mt-auto border-t border-white/5 px-6 py-3">
          <div className="flex flex-col gap-0.5 text-[9px] text-white/20">
            {LAYER_ORDER.map((l) => (
              <div key={l.key} className="flex justify-between">
                <span className="text-white/30">{l.label}</span>
                <span>{sel[l.key] ? sel[l.key].replace(".png", "").replace(/_/g, " ") : "none"}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── RIGHT: Layer picker ────────────────────────────────────── */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Layer tabs */}
        <div className="flex flex-shrink-0 border-b border-white/10">
          {LAYER_ORDER.map((layer) => {
            const isActive = activeLayer === layer.key;
            const hasSelection = sel[layer.key] !== "";
            return (
              <button
                key={layer.key}
                onClick={() => { setActiveLayer(layer.key); setActiveGroup(""); }}
                className={`relative flex-1 px-4 py-3 text-xs transition-all ${
                  isActive
                    ? "bg-gray-900 text-yellow-400"
                    : "text-white/40 hover:text-white/70 hover:bg-gray-900/50"
                }`}
              >
                {layer.label}
                {hasSelection && (
                  <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-yellow-400" />
                )}
                {isActive && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-yellow-400" />}
              </button>
            );
          })}
        </div>

        {/* Group sub-tabs */}
        {!isSimple && (
          <div className="flex flex-shrink-0 gap-1 overflow-x-auto border-b border-white/5 bg-gray-950 px-3 py-2">
            {isAccessory && (
              <button
                onClick={() => setSel((s) => ({ ...s, accessory: "" }))}
                className={`flex-shrink-0 rounded-md px-3 py-1.5 text-[11px] transition-all ${
                  sel.accessory === ""
                    ? "bg-yellow-400/10 text-yellow-400 border border-yellow-400/30"
                    : "text-white/30 hover:text-white/50 border border-transparent"
                }`}
              >
                None
              </button>
            )}
            {groups.map((g) => (
              <button
                key={g.key}
                onClick={() => setActiveGroup(g.key)}
                className={`flex-shrink-0 rounded-md px-3 py-1.5 text-[11px] transition-all ${
                  currentGroupKey === g.key
                    ? "bg-white/10 text-white border border-white/20"
                    : "text-white/30 hover:text-white/50 border border-transparent"
                }`}
              >
                {g.label}
              </button>
            ))}
          </div>
        )}

        {/* Items grid — composited onto body */}
        <div className="flex-1 overflow-y-auto p-4">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(76px,1fr))] gap-2">
            {currentFiles.map((f) => (
              <Thumb
                key={f}
                bodyFile={sel.body}
                layerKey={activeLayer}
                layerFile={f}
                folder={layerInfo.folder}
                selected={sel[activeLayer] === f}
                onClick={() => setSel((s) => ({ ...s, [activeLayer]: f }))}
                label={f.replace(".png", "").replace(/_/g, " ")}
              />
            ))}
          </div>

          {currentFiles.length === 0 && (
            <div className="flex h-32 items-center justify-center text-xs text-white/20">
              {isAccessory ? "select a category above" : "no items"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
