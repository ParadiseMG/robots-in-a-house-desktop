"use client";

import { useEffect, useRef } from "react";
import type {
  OfficeConfig,
  StationConfig,
  DeskConfig,
  IndicatorKind,
} from "@/lib/office-types";
import {
  preloadPremades,
  loadPremade,
  loadTilesheet,
  idleFramesForFacing,
  type PremadeFrames,
} from "@/lib/sprite-loader";
import { isContextWarning } from "@/lib/model-context";

type ModuleGeom = {
  officeSlug: string;
  offsetX: number;
  offsetY: number;
  tw: number;
  th: number;
  desks: DeskConfig[];
};

type Props = {
  station: StationConfig;
  offices: Record<string, OfficeConfig>;
  focusedModule: string | null;
  busyDeskIds?: ReadonlySet<string>;
  agentStatus?: ReadonlyMap<string, IndicatorKind>;
  /** deskId → count of active delegated child runs (renders orbiting satellite dots). */
  delegationsByDesk?: ReadonlyMap<string, number>;
  /** Active delegation pairs for beam lines: fromDeskId → toDeskId */
  delegationLinks?: ReadonlyArray<{ fromDeskId: string; toDeskId: string }>;
  selectedDeskId?: string | null;
  onDeskSelect?: (deskId: string | null) => void;
  onAgentClick?: (
    officeSlug: string,
    deskId: string,
    clientX: number,
    clientY: number,
  ) => void;
  onDeskDrop?: (
    officeSlug: string,
    deskId: string,
    e: React.DragEvent<HTMLDivElement>,
  ) => void;
  onAgentMove?: (
    officeSlug: string,
    deskId: string,
    gridX: number,
    gridY: number,
  ) => void;
  onModuleFocus?: (officeSlug: string) => void;
  onWarRoomClick?: (officeSlug: string) => void;
  onAgentHover?: (
    officeSlug: string,
    deskId: string,
    clientX: number,
    clientY: number,
  ) => void;
  onAgentHoverOut?: () => void;
  /** Fires whenever agent screen positions update (used for ambient bubbles) */
  onAgentPositions?: (positions: Map<string, { clientX: number; clientY: number }>) => void;
  /** Map of agentId → {model, tokens} for context warning overlay */
  contextUsage?: ReadonlyMap<string, { model: string | null; tokens: number }>;
  showGrid?: boolean;
};

export default function Station({
  station,
  offices,
  focusedModule,
  busyDeskIds,
  agentStatus,
  delegationsByDesk,
  delegationLinks,
  selectedDeskId,
  onDeskSelect,
  onAgentClick,
  onDeskDrop,
  onAgentMove,
  onModuleFocus,
  onWarRoomClick,
  onAgentHover,
  onAgentHoverOut,
  onAgentPositions,
  contextUsage,
  showGrid = false,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  // Live refs so the Pixi effect (which only runs once) can read current React props.
  const selectedRef = useRef<string | null>(selectedDeskId ?? null);
  selectedRef.current = selectedDeskId ?? null;
  const onSelectRef = useRef(onDeskSelect);
  onSelectRef.current = onDeskSelect;
  const onAgentClickRef = useRef(onAgentClick);
  onAgentClickRef.current = onAgentClick;
  const onAgentMoveRef = useRef(onAgentMove);
  onAgentMoveRef.current = onAgentMove;
  const onModuleFocusRef = useRef(onModuleFocus);
  onModuleFocusRef.current = onModuleFocus;
  const onWarRoomClickRef = useRef(onWarRoomClick);
  onWarRoomClickRef.current = onWarRoomClick;
  const onAgentHoverRef = useRef(onAgentHover);
  onAgentHoverRef.current = onAgentHover;
  const onAgentHoverOutRef = useRef(onAgentHoverOut);
  onAgentHoverOutRef.current = onAgentHoverOut;
  const onAgentPositionsRef = useRef(onAgentPositions);
  onAgentPositionsRef.current = onAgentPositions;
  const contextUsageRef = useRef(contextUsage);
  contextUsageRef.current = contextUsage;
  const showGridRef = useRef(showGrid);
  showGridRef.current = showGrid;
  const focusedRef = useRef<string | null>(focusedModule);
  focusedRef.current = focusedModule;

  const busyRef = useRef<ReadonlySet<string>>(busyDeskIds ?? new Set());
  busyRef.current = busyDeskIds ?? new Set();
  const statusRef = useRef<ReadonlyMap<string, IndicatorKind>>(
    agentStatus ?? new Map(),
  );
  const delegationsRef = useRef<ReadonlyMap<string, number>>(
    delegationsByDesk ?? new Map(),
  );
  delegationsRef.current = delegationsByDesk ?? new Map();
  const delegationLinksRef = useRef<ReadonlyArray<{ fromDeskId: string; toDeskId: string }>>(
    delegationLinks ?? [],
  );
  delegationLinksRef.current = delegationLinks ?? [];
  statusRef.current = agentStatus ?? new Map();

  // Shared geom for HTML5 drag-drop hit-testing across all modules.
  const geomRef = useRef<{
    canvas: HTMLCanvasElement | null;
    worldScale: number;
    worldX: number;
    worldY: number;
    modules: ModuleGeom[];
  }>({ canvas: null, worldScale: 1, worldX: 0, worldY: 0, modules: [] });

  useEffect(() => {
    let destroyed = false;
    let cleanup: (() => void) | undefined;

    (async () => {
      const PIXI = await import("pixi.js");
      const { AdvancedBloomFilter } = await import("pixi-filters");
      if (destroyed || !hostRef.current) return;

      const {
        Application,
        Container,
        Graphics,
        Rectangle,
        Sprite,
        AnimatedSprite,
        ColorMatrixFilter,
        Text,
        TextStyle,
        Assets,
      } = PIXI;

      const app = new Application();
      await app.init({
        background: "#070412",
        resizeTo: hostRef.current,
        antialias: false,
        roundPixels: true,
      });
      if (destroyed) {
        app.destroy(true, { children: true });
        return;
      }
      hostRef.current.appendChild(app.canvas);

      // ── World container (camera-controlled) ──────────────────────────────
      const world = new Container();
      app.stage.addChild(world);

      // ── Starfield (non-camera, but at world's bottom layer so it pans with void feel)
      // Implemented as a large tiled starfield in screen space: we redraw on resize.
      const starfield = new Graphics();
      app.stage.addChildAt(starfield, 0);

      const drawStarfield = () => {
        starfield.clear();
        // Base dark navy gradient approximation (flat navy; gradients are cheap via a radial later)
        starfield
          .rect(0, 0, app.renderer.width, app.renderer.height)
          .fill(0x070412);
        // Seeded pseudo-random stars
        const seed = station.background.seed;
        const density = station.background.density;
        const count = Math.floor(
          app.renderer.width * app.renderer.height * density,
        );
        // Simple mulberry32 PRNG
        let s = (seed * 2654435761) >>> 0;
        const rnd = () => {
          s = (s + 0x6d2b79f5) >>> 0;
          let t = s;
          t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        for (let i = 0; i < count; i++) {
          const x = rnd() * app.renderer.width;
          const y = rnd() * app.renderer.height;
          const r = rnd();
          const size = r < 0.8 ? 1 : r < 0.97 ? 1.5 : 2.2;
          const col =
            r < 0.75 ? 0xffffff : r < 0.9 ? 0xb4cfff : 0xffd9ff;
          const alpha = 0.35 + rnd() * 0.65;
          starfield.circle(x, y, size).fill({ color: col, alpha });
        }
      };
      drawStarfield();

      // ── Bloom on world ───────────────────────────────────────────────────
      const bloom = new AdvancedBloomFilter({
        threshold: 0.88,
        bloomScale: 0.18,
        brightness: 1.0,
        blur: 3,
        quality: 4,
      });
      world.filters = [bloom];

      // ── Mount each module ────────────────────────────────────────────────
      type ModuleHandle = {
        slug: string;
        container: InstanceType<typeof Container>;
        offsetX: number;
        offsetY: number;
        tw: number;
        th: number;
        worldW: number;
        worldH: number;
        office: OfficeConfig;
        gridOverlay: InstanceType<typeof Container>;
        deskShapes: Map<string, InstanceType<typeof Graphics>>;
        agentSprites: Map<string, AgentSprites>;
        deskOfAgent: Map<string, string>;
        premadeRoomConfig: OfficeConfig["theme"]["premadeRoom"];
        tilesheet: boolean;
      };

      type AgentSprites = {
        body: InstanceType<typeof AnimatedSprite>;
        pip: InstanceType<typeof Graphics>;
        exclamation: InstanceType<typeof Graphics>;
        check: InstanceType<typeof Graphics>;
        ctxWarning: InstanceType<typeof Text>;
        nameTag: InstanceType<typeof Container>;
        shadow: InstanceType<typeof Graphics>;
        deskGlow: InstanceType<typeof Graphics>;
        satellites: InstanceType<typeof Graphics>;
        lastSatCount: number;
        indicatorBaseY: number;
        agentId: string;
        model: string | null;
        restX: number;
        restY: number;
        lastKind: string | undefined;
        anim: { type: "none" | "bounce" | "shake" | "slump"; t: number };
        allFrames: PremadeFrames["frames"];
        idleFacing: "N" | "E" | "S" | "W";
        wanderTimer: number;
        wanderTarget: { x: number; y: number; dir: "N" | "E" | "S" | "W"; returning: boolean; pause?: number; legsLeft?: number } | null;
        pendingKind: string | undefined;
        breathPhase: number;
        particles: Array<{ x: number; y: number; vx: number; vy: number; life: number; maxLife: number; color: number; kind: "star" | "sweat" }>;
        particleGraphics: InstanceType<typeof Graphics>;
        baseScaleX: number;
        baseScaleY: number;
        workingFacing: "N" | "E" | "S" | "W";
        typingDots: InstanceType<typeof Graphics>;
        isWorking: boolean;
        officeSlug: string;
        isHead: boolean;
        sunglasses: InstanceType<typeof Graphics> | null;
        zzzGraphics: InstanceType<typeof Graphics>;
        zzzPhase: number;
        emoteGraphics: InstanceType<typeof Graphics>;
        emoteTimer: number;
        chairSprite: InstanceType<typeof Container> | InstanceType<typeof Graphics> | null;
        monitorSprite: InstanceType<typeof Container> | null;
        lastRunTs: number;
      };

      // Shared drag state — at most one agent dragging at a time across modules.
      type DragState = {
        deskId: string;
        officeSlug: string;
        body: InstanceType<typeof AnimatedSprite>;
        module: ModuleHandle;
        origX: number;
        origY: number;
        startPointerX: number;
        startPointerY: number;
        started: boolean;
      };
      let drag: DragState | null = null;
      let htmlDragActive = false;
      const onHtmlDragStart = () => {
        htmlDragActive = true;
      };
      const onHtmlDragEnd = () => {
        htmlDragActive = false;
      };
      document.addEventListener("dragstart", onHtmlDragStart);
      document.addEventListener("dragend", onHtmlDragEnd);

      // Camera pan (middle of empty space) state
      type PanState = {
        startPointerX: number;
        startPointerY: number;
        startWorldX: number;
        startWorldY: number;
        started: boolean;
      };
      let pan: PanState | null = null;

      const modules: ModuleHandle[] = [];

      const nameTagStyle = new TextStyle({
        fontFamily: "monospace",
        fontSize: 18,
        fill: 0xffffff,
        stroke: { color: 0x000000, width: 3, join: "round" },
      });

      const roleColor = (role: string, name = ""): number => {
        if (name === "Maestro") return 0xe11d48; // rose — Paradise director
        const r = role.toLowerCase();
        if (/director|lead/.test(r))                          return 0xd97706; // amber
        if (/design|creative|content|visual|art/.test(r))    return 0x7c3aed; // violet
        if (/engineer|infra|deploy|environment|monitor|bug/.test(r)) return 0x0284c7; // sky
        if (/finance|commerce|ticketing|merch|sponsorship/.test(r))  return 0x047857; // emerald
        if (/ops|bot|support|sales|promo|marketing|guest|a&r/.test(r)) return 0xc2410c; // orange
        return 0x1e293b; // default slate
      };

      const buildNameTag = (name: string, role = "", agentName = "") => {
        const c = new Container();
        const label = new Text({ text: name, style: nameTagStyle });
        label.anchor.set(0.5, 0.5);
        const padX = 5;
        const padY = 2;
        const w = Math.ceil(label.width) + padX * 2;
        const h = Math.ceil(label.height) + padY * 2;
        const color = roleColor(role, agentName);
        const bg = new Graphics()
          .roundRect(-w / 2, -h / 2, w, h, 4)
          .fill({ color, alpha: 0.85 })
          .stroke({ color: 0xffffff, alpha: 0.2, width: 1 });
        c.addChild(bg, label);
        return c;
      };

      const drawExclamation = (g: InstanceType<typeof Graphics>) => {
        g.clear();
        g.roundRect(-11, -14, 22, 26, 5)
          .fill(0xfacc15)
          .stroke({ color: 0x000000, width: 1.5 });
        g.rect(-1.75, -9, 3.5, 12).fill(0xffffff);
        g.circle(0, 7, 2).fill(0xffffff);
      };

      const drawCheck = (g: InstanceType<typeof Graphics>) => {
        g.clear();
        g.circle(0, 0, 12)
          .fill(0x10b981)
          .stroke({ color: 0x000000, width: 1.5 });
        g.moveTo(-5, 0)
          .lineTo(-1, 5)
          .lineTo(6, -5)
          .stroke({
            color: 0xffffff,
            width: 2.5,
            cap: "round",
            join: "round",
          });
      };

      const emitAgentClick = (
        officeSlug: string,
        deskId: string,
        body: InstanceType<typeof AnimatedSprite>,
      ) => {
        const globalPos = body.getGlobalPosition();
        const rect = app.canvas.getBoundingClientRect();
        const sx = rect.width / app.canvas.width;
        const sy = rect.height / app.canvas.height;
        const clientX = rect.left + globalPos.x * sx;
        const clientY = rect.top + (globalPos.y - body.height - 8) * sy;
        onAgentClickRef.current?.(officeSlug, deskId, clientX, clientY);
      };

      for (const moduleCfg of station.modules) {
        const office = offices[moduleCfg.office];
        if (!office) continue;

        // Preload character sheets for this module
        const premadePaths = office.agents
          .map((a) => a.visual?.premade ? `/sprites/characters/${a.visual.premade}` : null)
          .filter(Boolean) as string[];
        await preloadPremades(premadePaths);

        const premadeRoomConfig = office.theme.premadeRoom;
        const interiorConfig = office.theme.interior;
        let tilesheet: Awaited<ReturnType<typeof loadTilesheet>> | null = null;
        if (!premadeRoomConfig && interiorConfig) {
          tilesheet = await loadTilesheet(
            `/sprites/interiors/${interiorConfig.tilesheet}`,
            interiorConfig.tileSize,
          );
        }

        // Desk furniture tilesheet — chairs and monitors
        const deskStyleCfg = office.theme.deskStyle;
        let deskTilesheet: Awaited<ReturnType<typeof loadTilesheet>> | null = null;
        if (deskStyleCfg) {
          deskTilesheet = await loadTilesheet(
            `/sprites/interiors/${deskStyleCfg.tilesheet}`,
            16,
          );
        }

        let roomLayerTextures: InstanceType<typeof PIXI.Texture>[] = [];
        if (premadeRoomConfig) {
          roomLayerTextures = await Promise.all(
            premadeRoomConfig.layers.map(
              (layerPath) =>
                Assets.load(
                  `/sprites/interiors/premade_rooms/${layerPath}`,
                ) as Promise<InstanceType<typeof PIXI.Texture>>,
            ),
          );
        }
        if (destroyed) {
          app.destroy(true, { children: true });
          return;
        }

        const tw = office.tile.w;
        const th = office.tile.h;
        const worldW = office.grid.cols * tw;
        const worldH = office.grid.rows * th;

        // Module container — positioned in world coords, all child coords are local 0..worldW
        const moduleContainer = new Container();
        moduleContainer.position.set(moduleCfg.offsetX, moduleCfg.offsetY);
        moduleContainer.eventMode = "static";
        world.addChild(moduleContainer);

        // Per-module outer glow — soft radial behind the room
        const glow = new Graphics();
        glow.eventMode = "none";
        const glowPad = Math.max(worldW, worldH) * 0.3;
        const glowColor = hexToInt(moduleCfg.accent);
        // Stack of fading rings for a cheap soft outer glow
        for (let i = 6; i >= 1; i--) {
          const pad = (glowPad / 6) * i;
          const a = 0.03 * (7 - i);
          glow
            .roundRect(-pad, -pad, worldW + pad * 2, worldH + pad * 2, 16)
            .fill({ color: glowColor, alpha: a });
        }
        moduleContainer.addChild(glow);

        // Module sub-layers
        const roomBg = new Container();
        const floor = new Container();
        const furniture = new Container();
        const roomFg = new Container();
        roomFg.eventMode = "none"; // foreground layers must not block agent clicks
        const gridOverlay = new Container();
        gridOverlay.visible = showGridRef.current;
        moduleContainer.addChild(roomBg, floor, furniture, roomFg, gridOverlay);

        // Per-module palette filter
        const pf = office.theme.paletteFilter;
        if (pf) {
          const filters: InstanceType<typeof ColorMatrixFilter>[] = [];
          const cmf = new ColorMatrixFilter();
          if (pf.hue !== undefined) cmf.hue(pf.hue, false);
          if (pf.saturation !== undefined) cmf.saturate(pf.saturation - 1, true);
          if (pf.brightness !== undefined) cmf.brightness(pf.brightness, true);
          if (pf.contrast !== undefined) cmf.contrast(pf.contrast * 0.5, true);
          filters.push(cmf);
          if (pf.tint !== undefined && pf.tintStrength !== undefined) {
            const tintFilter = new ColorMatrixFilter();
            tintFilter.tint(pf.tint, false);
            tintFilter.alpha = pf.tintStrength;
            filters.push(tintFilter);
          }
          // Apply to the module sub-containers (NOT moduleContainer itself, so outer glow stays pure)
          roomBg.filters = filters;
          floor.filters = filters;
          furniture.filters = filters;
          roomFg.filters = filters;
        }

        // Neon trim frame around the module
        const trim = new Graphics();
        trim.eventMode = "none"; // must not block agent clicks
        trim
          .roundRect(-2, -2, worldW + 4, worldH + 4, 3)
          .stroke({ color: glowColor, width: 2, alpha: 0.8 });
        trim
          .roundRect(-5, -5, worldW + 10, worldH + 10, 5)
          .stroke({ color: glowColor, width: 1, alpha: 0.35 });
        moduleContainer.addChild(trim);

        const flat = (gx: number, gy: number) => ({ x: gx * tw, y: gy * th });
        const inRoom = (gx: number, gy: number) =>
          office.rooms.some(
            (r) =>
              gx >= r.gridX &&
              gx < r.gridX + r.w &&
              gy >= r.gridY &&
              gy < r.gridY + r.h,
          );

        if (premadeRoomConfig && roomLayerTextures.length > 0) {
          const scale = tw / premadeRoomConfig.sourceTileSize;
          const depthIdx =
            premadeRoomConfig.characterDepthIndex ?? roomLayerTextures.length;
          roomLayerTextures.forEach((tex, i) => {
            tex.source.scaleMode = "nearest";
            const s = new Sprite(tex);
            s.anchor.set(0, 0);
            s.position.set(0, 0);
            s.scale.set(scale);
            if (i < depthIdx) roomBg.addChild(s);
            else roomFg.addChild(s);
          });
        } else {
          for (let gy = 0; gy < office.grid.rows; gy++) {
            for (let gx = 0; gx < office.grid.cols; gx++) {
              const { x, y } = flat(gx, gy);
              const isIn = inRoom(gx, gy);
              if (tilesheet && interiorConfig) {
                const [col, row] = isIn
                  ? interiorConfig.floorTileIndex
                  : (interiorConfig.wallTileIndex ??
                    interiorConfig.floorTileIndex);
                const tex = tilesheet.getTile(col, row);
                tex.source.scaleMode = "nearest";
                const tile = new Sprite(tex);
                tile.width = tw;
                tile.height = th;
                tile.anchor.set(0, 0);
                tile.position.set(x, y);
                floor.addChild(tile);
              } else {
                const color = isIn
                  ? (gx + gy) % 2 === 0
                    ? office.theme.floor
                    : office.theme.floorAlt
                  : office.theme.wall;
                const tile = new Graphics()
                  .rect(0, 0, tw, th)
                  .fill(color)
                  .stroke({ color: 0x000000, width: 1, alpha: 0.25 });
                tile.position.set(x, y);
                floor.addChild(tile);
              }
            }
          }
        }

        // Desks
        furniture.sortableChildren = true;
        const deskShapes = new Map<string, InstanceType<typeof Graphics>>();

        const paintDesk = (
          g: InstanceType<typeof Graphics>,
          highlighted: boolean,
        ) => {
          g.clear();
          g.rect(0, 0, tw, th)
            .fill(highlighted ? office.theme.highlight : office.theme.deskTop)
            .stroke({ color: 0x000000, width: 2, alpha: 0.6 });
          g.rect(tw * 0.1, th * 0.1, tw * 0.8, th * 0.6)
            .fill(office.theme.deskSide)
            .stroke({ color: 0x000000, width: 1, alpha: 0.4 });
        };

        for (const desk of office.desks) {
          const { x, y } = flat(desk.gridX, desk.gridY);
          const zBase = desk.gridY * office.grid.cols + desk.gridX;

          if (tilesheet && interiorConfig) {
            const [col, row] = interiorConfig.floorTileIndex;
            const tex = tilesheet.getTile(col, row);
            tex.source.scaleMode = "nearest";
            const s = new Sprite(tex);
            s.width = tw;
            s.height = th;
            s.anchor.set(0, 0);
            s.tint = parseInt(office.theme.deskTop.replace("#", ""), 16);
            s.position.set(x, y);
            s.zIndex = zBase + 1;
            furniture.addChild(s);
          }

          const g = new Graphics();
          paintDesk(g, false);
          g.position.set(x, y);
          g.eventMode = "static";
          g.cursor = "pointer";
          g.zIndex = zBase + 1;
          const deskId = desk.id;
          g.on("pointertap", () => onSelectRef.current?.(deskId));
          if (premadeRoomConfig || tilesheet) g.alpha = 0;
          deskShapes.set(desk.id, g);
          furniture.addChild(g);
        }

        // War-room data is kept in config for the chat dock — visual cells removed.

        // Agents
        const agentSprites = new Map<string, AgentSprites>();
        const deskOfAgent = new Map(office.agents.map((a) => [a.deskId, a.id]));

        const moduleHandleForBody = {} as ModuleHandle; // forward-declared so pointerdown closures capture it

        for (const agent of office.agents) {
          if (!agent.visual?.premade) continue; // skip agents with no sprite
          const desk = office.desks.find((d) => d.id === agent.deskId);
          if (!desk) continue;

          const { x, y } = flat(desk.gridX, desk.gridY);
          const agentCenterX = x + tw / 2;
          const agentBottomY = y + th * 0.75;

          const premadePath = `/sprites/characters/${agent.visual.premade}`;
          const premadeData = await loadPremade(premadePath);
          const frames = idleFramesForFacing(premadeData.frames, desk.facing);

          const body = new AnimatedSprite({
            textures: frames,
            animationSpeed: 0.08,
            loop: true,
            autoPlay: true,
          });
          body.anchor.set(0.5, 1.0);
          const charScale = tw / 16;
          body.scale.set(charScale);
          const baseScaleX = charScale;
          const baseScaleY = charScale;
          body.position.set(agentCenterX, agentBottomY);
          const zBase = desk.gridY * office.grid.cols + desk.gridX;
          body.zIndex = zBase + 3;
          body.eventMode = "static";
          body.cursor = "pointer";
          // Explicit hit area in local (unscaled) coords — sprites are 16x32
          // with anchor (0.5, 1.0). Pad generously so clicks always register
          // regardless of transparent pixels or animation frame.
          body.hitArea = new Rectangle(-10, -34, 20, 36);
          const deskId = desk.id;
          const officeSlug = office.slug;
          body.on("pointertap", (ev) => {
            if (ev.button !== 0) return;
            emitAgentClick(officeSlug, deskId, body);
            ev.stopPropagation();
          });
          body.on("pointerdown", (ev) => {
            if (ev.button !== 0) return;
            if (htmlDragActive) return;
            ev.stopPropagation();
            const gpos = ev.global;
            drag = {
              deskId,
              officeSlug,
              body,
              module: moduleHandleForBody,
              origX: body.x,
              origY: body.y,
              startPointerX: gpos.x,
              startPointerY: gpos.y,
              started: false,
            };
            body.cursor = "grabbing";
          });
          body.on("pointerover", (ev) => {
            const rect = app.canvas.getBoundingClientRect();
            const sx = rect.width / app.canvas.width;
            const sy = rect.height / app.canvas.height;
            const globalPos = body.getGlobalPosition();
            const clientX = rect.left + globalPos.x * sx;
            const clientY = rect.top + (globalPos.y - body.height / 2) * sy;
            onAgentHoverRef.current?.(officeSlug, deskId, clientX, clientY);
            ev.stopPropagation();
          });
          body.on("pointerout", () => {
            onAgentHoverOutRef.current?.();
          });
          // ZZZ sleep graphics — shown when agent has been idle 1+ day
          const zzzGraphics = new Graphics();
          zzzGraphics.zIndex = zBase + 8;
          zzzGraphics.visible = false;
          furniture.addChild(zzzGraphics);

          // Emote graphics — small bubble during social encounters
          const emoteGraphics = new Graphics();
          emoteGraphics.zIndex = zBase + 9;
          emoteGraphics.visible = false;
          furniture.addChild(emoteGraphics);

          // Desk furniture sprites — chair/towel behind agent, monitor in front
          let chairRef: InstanceType<typeof Container> | InstanceType<typeof Graphics> | null = null;
          let monRef: InstanceType<typeof Container> | null = null;
          if (deskTilesheet && deskStyleCfg) {
            const { chair, monitor } = deskStyleCfg;
            const tileScale = tw / 16;
            const chairType = deskStyleCfg.chairType ?? "tile";
            const headScale = agent.isHead ? 1.3 : 1.0;

            if (chairType === "towel") {
              // Beach towel — drawn with Graphics, striped pattern
              const towel = new Graphics();
              const baseColor = deskStyleCfg.towelColor
                ? parseInt(deskStyleCfg.towelColor.replace("#", ""), 16)
                : 0xf59e0b;
              // Darken helper: shift each channel down ~30%
              const darken = (c: number) => {
                const r = Math.floor(((c >> 16) & 0xff) * 0.65);
                const g = Math.floor(((c >> 8) & 0xff) * 0.65);
                const b = Math.floor((c & 0xff) * 0.65);
                return (r << 16) | (g << 8) | b;
              };
              const stripe = darken(baseColor);
              const towelW = 28; // px before scaling
              const towelH = 18;
              // Base towel shape
              towel.roundRect(-towelW / 2, -towelH / 2, towelW, towelH, 2)
                .fill({ color: baseColor, alpha: 0.9 });
              // Horizontal stripes
              for (let sy = 0; sy < 3; sy++) {
                const stripeY = -towelH / 2 + 3 + sy * 5;
                towel.rect(-towelW / 2 + 2, stripeY, towelW - 4, 2)
                  .fill({ color: stripe, alpha: 0.5 });
              }
              // White fringe at short edges
              towel.rect(-towelW / 2, -towelH / 2, 2, towelH)
                .fill({ color: 0xffffff, alpha: 0.3 });
              towel.rect(towelW / 2 - 2, -towelH / 2, 2, towelH)
                .fill({ color: 0xffffff, alpha: 0.3 });
              // Subtle shadow/border
              towel.roundRect(-towelW / 2, -towelH / 2, towelW, towelH, 2)
                .stroke({ color: 0x000000, alpha: 0.15, width: 0.5 });
              towel.scale.set(tileScale * headScale);
              towel.position.set(agentCenterX, agentBottomY - th * 0.25);
              towel.zIndex = zBase + 1; // below agent
              furniture.addChild(towel);
              chairRef = towel;
            } else {
              // Chair — 2x2 tile block, centered on desk cell, behind agent
              const chairContainer = new Container();
              for (let dy = 0; dy < 2; dy++) {
                for (let dx = 0; dx < 2; dx++) {
                  const tex = deskTilesheet.getTile(chair[0] + dx, chair[1] + dy);
                  tex.source.scaleMode = "nearest";
                  const tile = new Sprite(tex);
                  tile.x = dx * 16;
                  tile.y = dy * 16;
                  chairContainer.addChild(tile);
                }
              }
              chairContainer.pivot.set(16, 16);
              chairContainer.scale.set(tileScale * headScale);
              chairContainer.position.set(agentCenterX, agentBottomY - th * 0.25);
              chairContainer.zIndex = zBase + 2; // below body (zBase+3)
              furniture.addChild(chairContainer);
              chairRef = chairContainer;
            }

            // Monitor — 2x1 tile block, offset in desk facing direction (skip for towel mode)
            if (chairType !== "towel") {
              const monContainer = new Container();
              for (let dx = 0; dx < 2; dx++) {
                const tex = deskTilesheet.getTile(monitor[0] + dx, monitor[1]);
                tex.source.scaleMode = "nearest";
                const tile = new Sprite(tex);
                tile.x = dx * 16;
                tile.y = 0;
                monContainer.addChild(tile);
              }
              monContainer.pivot.set(16, 8);
              monContainer.scale.set(tileScale * headScale);
              const monOffset = tw * 0.8;
              const facing = desk.facing;
              const monX = agentCenterX + (facing === "E" ? monOffset : facing === "W" ? -monOffset : 0);
              const monY = (agentBottomY - th * 0.25) + (facing === "S" ? monOffset : facing === "N" ? -monOffset : 0);
              monContainer.position.set(monX, monY);
              monContainer.zIndex = zBase + 2;
              furniture.addChild(monContainer);
              monRef = monContainer;
            }
          }

          furniture.addChild(body);

          // Particle graphics — renders particle bursts in the same container as body
          const particleGraphics = new Graphics();
          particleGraphics.zIndex = zBase + 9;
          particleGraphics.visible = false;
          furniture.addChild(particleGraphics);

          const indicatorBaseY = agentBottomY - body.height - 14;
          const pip = new Graphics();
          pip
            .circle(0, 0, 4)
            .fill(office.theme.highlight)
            .stroke({ color: 0x000000, width: 1 });
          pip.position.set(agentCenterX, indicatorBaseY + 4);
          pip.zIndex = zBase + 4;
          pip.visible = false;
          furniture.addChild(pip);

          const exclamation = new Graphics();
          drawExclamation(exclamation);
          exclamation.position.set(agentCenterX, indicatorBaseY);
          exclamation.zIndex = zBase + 6;
          exclamation.visible = false;
          exclamation.eventMode = "static";
          exclamation.cursor = "pointer";
          exclamation.on("pointertap", (ev) => {
            emitAgentClick(officeSlug, deskId, body);
            ev.stopPropagation();
          });
          furniture.addChild(exclamation);

          const check = new Graphics();
          drawCheck(check);
          check.position.set(agentCenterX, indicatorBaseY);
          check.zIndex = zBase + 6;
          check.visible = false;
          check.eventMode = "static";
          check.cursor = "pointer";
          check.on("pointertap", (ev) => {
            emitAgentClick(officeSlug, deskId, body);
            ev.stopPropagation();
          });
          furniture.addChild(check);

          const nameTag = buildNameTag(agent.name, agent.role, agent.name);
          const nameTagY = agentBottomY - body.height - 46;
          nameTag.position.set(agentCenterX, nameTagY);
          nameTag.zIndex = zBase + 7;
          nameTag.eventMode = "none";
          furniture.addChild(nameTag);

          // Context warning overlay (⚠) — shown when model ctx ≥ 80%
          const ctxWarning = new Text({
            text: "⚠",
            style: new TextStyle({
              fontFamily: "monospace",
              fontSize: 11,
              fill: 0xfbbf24,
              stroke: { color: 0x000000, width: 2, join: "round" },
            }),
          });
          ctxWarning.anchor.set(0.5, 0.5);
          ctxWarning.position.set(agentCenterX + body.width * 0.3, indicatorBaseY + 10);
          ctxWarning.zIndex = zBase + 8;
          ctxWarning.visible = false;
          furniture.addChild(ctxWarning);

          // Drop shadow — stays on ground, squishes during bounce
          const shadow = new Graphics();
          shadow.ellipse(0, 0, (tw * 0.38), (th * 0.18)).fill({ color: 0x000000, alpha: 0.28 });
          shadow.position.set(agentCenterX, agentBottomY - 2);
          shadow.zIndex = zBase + 2;
          furniture.addChild(shadow);

          // Desk glow — colored halo behind desk tile, driven by status
          const deskGlow = new Graphics();
          deskGlow.circle(0, 0, Math.max(tw, th) * 0.72).fill({ color: 0xffffff, alpha: 0 });
          deskGlow.position.set(x + tw / 2, y + th / 2);
          deskGlow.zIndex = zBase;
          furniture.addChild(deskGlow);

          // Satellites — orbiting dots around the agent showing active delegated child runs
          const satellites = new Graphics();
          satellites.position.set(agentCenterX, agentBottomY - body.height / 2);
          satellites.zIndex = zBase + 7;
          satellites.visible = false;
          furniture.addChild(satellites);

          // Working facing = opposite of desk facing (agent turns to face the desk)
          const oppFacing = (f: "N" | "E" | "S" | "W"): "N" | "E" | "S" | "W" =>
            f === "N" ? "S" : f === "S" ? "N" : f === "E" ? "W" : "E";
          const workingFacing = oppFacing(desk.facing);

          // Typing dots — animated indicator shown while agent is working
          const typingDots = new Graphics();
          typingDots.zIndex = zBase + 8;
          typingDots.visible = false;
          furniture.addChild(typingDots);

          agentSprites.set(agent.id, {
            body,
            pip,
            exclamation,
            check,
            ctxWarning,
            nameTag,
            shadow,
            deskGlow,
            satellites,
            lastSatCount: 0,
            indicatorBaseY,
            agentId: agent.id,
            model: agent.model ?? null,
            restX: agentCenterX,
            restY: agentBottomY,
            lastKind: undefined,
            anim: { type: "none", t: 0 },
            allFrames: premadeData.frames,
            idleFacing: desk.facing,
            wanderTimer: 2 + Math.random() * 6,
            wanderTarget: null,
            pendingKind: undefined,
            breathPhase: Math.random() * Math.PI * 2,
            particles: [],
            particleGraphics,
            baseScaleX,
            baseScaleY,
            workingFacing,
            typingDots,
            isWorking: false,
            officeSlug,
            isHead: agent.isHead ?? false,
            sunglasses: null,
            zzzGraphics,
            zzzPhase: Math.random() * Math.PI * 2,
            emoteGraphics,
            emoteTimer: 0,
            chairSprite: chairRef,
            monitorSprite: monRef,
            lastRunTs: Date.now(),
          });
        }

        // Ghost (drag preview) — per-module so it snaps in module-local coords
        const ghost = new Graphics();
        ghost.visible = false;
        ghost.zIndex = 9999;
        furniture.addChild(ghost);

        // Grid overlay
        {
          const lineStyle = {
            color: 0xffffff,
            alpha: 0.3,
            width: 1,
          } as const;
          const labelStyle = new TextStyle({
            fontFamily: "monospace",
            fontSize: 8,
            fill: { color: 0xffffff, alpha: 0.5 },
          });
          const g = new Graphics();
          for (let gx = 0; gx <= office.grid.cols; gx++) {
            g.moveTo(gx * tw, 0).lineTo(gx * tw, office.grid.rows * th);
          }
          for (let gy = 0; gy <= office.grid.rows; gy++) {
            g.moveTo(0, gy * th).lineTo(office.grid.cols * tw, gy * th);
          }
          g.stroke(lineStyle);
          gridOverlay.addChild(g);
          for (let gy = 0; gy < office.grid.rows; gy++) {
            for (let gx = 0; gx < office.grid.cols; gx++) {
              const label = new Text({
                text: `${gx},${gy}`,
                style: labelStyle,
              });
              label.position.set(gx * tw + 2, gy * th + 2);
              gridOverlay.addChild(label);
            }
          }
        }

        // Module background click: focus this module + deselect desk
        moduleContainer.on("pointertap", (ev) => {
          if (ev.button !== 0) return;
          if (ev.target === moduleContainer || ev.target === roomBg) {
            onModuleFocusRef.current?.(office.slug);
          }
        });

        const handle: ModuleHandle = {
          slug: office.slug,
          container: moduleContainer,
          offsetX: moduleCfg.offsetX,
          offsetY: moduleCfg.offsetY,
          tw,
          th,
          worldW,
          worldH,
          office,
          gridOverlay,
          deskShapes,
          agentSprites,
          deskOfAgent,
          premadeRoomConfig,
          tilesheet: !!tilesheet,
        };
        Object.assign(moduleHandleForBody, handle);
        // Attach ghost to module so it shares local coords
        (handle as ModuleHandle & { ghost: InstanceType<typeof Graphics> }).ghost = ghost;
        (moduleHandleForBody as ModuleHandle & { ghost: InstanceType<typeof Graphics> }).ghost = ghost;
        modules.push(handle);
      }

      // ── Beam overlay — drawn above all module furniture, in world space ──
      const beamOverlay = new Graphics();
      beamOverlay.eventMode = "none"; // must not block agent clicks
      world.addChild(beamOverlay);

      // ── Camera: compute target transform ────────────────────────────────
      const cameraTarget = { x: 0, y: 0, scale: 1 };
      const cameraCurrent = { x: 0, y: 0, scale: 1 };

      const computeOverviewTarget = () => {
        // Fit ALL modules into view with padding.
        let maxX = 0;
        let maxY = 0;
        for (const m of modules) {
          maxX = Math.max(maxX, m.offsetX + m.worldW);
          maxY = Math.max(maxY, m.offsetY + m.worldH);
        }
        const pad = 120;
        const W = maxX + pad * 2;
        const H = maxY + pad * 2;
        const scale = Math.min(
          app.renderer.width / W,
          app.renderer.height / H,
        );
        const centerX = maxX / 2;
        const centerY = maxY / 2;
        cameraTarget.scale = scale;
        cameraTarget.x = app.renderer.width / 2 - centerX * scale;
        cameraTarget.y = app.renderer.height / 2 - centerY * scale;
      };

      const computeFocusTarget = (slug: string) => {
        const m = modules.find((mm) => mm.slug === slug);
        if (!m) return computeOverviewTarget();
        const pad = 60;
        const W = m.worldW + pad * 2;
        const H = m.worldH + pad * 2;
        const scale = Math.min(
          app.renderer.width / W,
          app.renderer.height / H,
        );
        const centerX = m.offsetX + m.worldW / 2;
        const centerY = m.offsetY + m.worldH / 2;
        cameraTarget.scale = scale;
        cameraTarget.x = app.renderer.width / 2 - centerX * scale;
        cameraTarget.y = app.renderer.height / 2 - centerY * scale;
      };

      const refreshCameraTarget = () => {
        if (focusedRef.current) computeFocusTarget(focusedRef.current);
        else computeOverviewTarget();
      };
      refreshCameraTarget();
      // Snap camera to target on first frame (no tween on mount)
      cameraCurrent.x = cameraTarget.x;
      cameraCurrent.y = cameraTarget.y;
      cameraCurrent.scale = cameraTarget.scale;
      world.position.set(cameraCurrent.x, cameraCurrent.y);
      world.scale.set(cameraCurrent.scale);

      const onResize = () => {
        drawStarfield();
        refreshCameraTarget();
      };
      app.renderer.on("resize", onResize);

      // ── Stage-level pointer routing ──────────────────────────────────────
      app.stage.eventMode = "static";

      // Click on empty space (not on any module) = defocus (overview)
      app.stage.on("pointertap", (ev) => {
        if (ev.button !== 0) return;
        // Only fire if the tap landed on the stage itself, not a module/sprite
        if (ev.target === app.stage) {
          onSelectRef.current?.(null);
        }
      });

      // Camera pan: left-click or middle-click anywhere (agents stop propagation so they won't trigger this)
      app.stage.on("pointerdown", (ev) => {
        if (drag) return;
        if (ev.button !== 0 && ev.button !== 1) return;
        const gpos = ev.global;
        pan = {
          startPointerX: gpos.x,
          startPointerY: gpos.y,
          startWorldX: world.x,
          startWorldY: world.y,
          started: false,
        };
      });

      const paintGhost = (
        ghost: InstanceType<typeof Graphics>,
        tw: number,
        th: number,
        valid: boolean,
      ) => {
        ghost.clear();
        ghost
          .rect(0, 0, tw, th)
          .fill({ color: valid ? 0x00ff88 : 0xff4444, alpha: 0.35 })
          .stroke({
            color: valid ? 0x00ff88 : 0xff4444,
            width: 2,
            alpha: 0.8,
          });
      };

      app.stage.on("pointermove", (ev) => {
        const gpos = ev.global;

        if (drag) {
          const dx = gpos.x - drag.startPointerX;
          const dy = gpos.y - drag.startPointerY;
          if (!drag.started) {
            if (Math.sqrt(dx * dx + dy * dy) < 4) return;
            drag.started = true;
            // Switch to walk animation
            const aidWalk = drag.module.deskOfAgent.get(drag.deskId);
            if (aidWalk) {
              const sp = drag.module.agentSprites.get(aidWalk);
              if (sp) {
                sp.body.textures = sp.allFrames.walkS;
                sp.body.animationSpeed = 0.14;
                sp.body.play();
              }
            }
          }
          // Convert to module-local coords
          const localPos = drag.module.container.toLocal(gpos);
          drag.body.position.set(localPos.x, localPos.y);
          const aid = drag.module.deskOfAgent.get(drag.deskId);
          if (aid) {
            const sprites = drag.module.agentSprites.get(aid);
            if (sprites) {
              sprites.nameTag.position.set(
                localPos.x,
                localPos.y - drag.body.height - 46,
              );
              sprites.shadow.position.set(localPos.x, localPos.y - 2);
              // Desk furniture follows during drag
              const mth = drag.module.th;
              const mtw = drag.module.tw;
              if (sprites.chairSprite) {
                sprites.chairSprite.position.set(localPos.x, localPos.y - mth * 0.25);
              }
              if (sprites.monitorSprite) {
                const dragNow = drag;
                const deskCfg = dragNow?.module.office.desks.find((dd) => dd.id === dragNow?.deskId);
                const facing = deskCfg?.facing ?? "S";
                const monOffset = mtw * 0.8;
                const monX = localPos.x + (facing === "E" ? monOffset : facing === "W" ? -monOffset : 0);
                const monY = (localPos.y - mth * 0.25) + (facing === "S" ? monOffset : facing === "N" ? -monOffset : 0);
                sprites.monitorSprite.position.set(monX, monY);
              }
            }
          }
          const snapGX = Math.floor(localPos.x / drag.module.tw);
          const snapGY = Math.floor(localPos.y / drag.module.th);
          const inBounds =
            snapGX >= 0 &&
            snapGX < drag.module.office.grid.cols &&
            snapGY >= 0 &&
            snapGY < drag.module.office.grid.rows;
          const occupied = inBounds
            ? drag.module.office.desks.some(
                (d) =>
                  d.id !== drag!.deskId &&
                  d.gridX === snapGX &&
                  d.gridY === snapGY,
              )
            : false;
          const valid = inBounds && !occupied;
          const ghost = (
            drag.module as ModuleHandle & { ghost: InstanceType<typeof Graphics> }
          ).ghost;
          ghost.position.set(snapGX * drag.module.tw, snapGY * drag.module.th);
          ghost.visible = true;
          paintGhost(ghost, drag.module.tw, drag.module.th, valid);
          return;
        }

        if (pan) {
          const dx = gpos.x - pan.startPointerX;
          const dy = gpos.y - pan.startPointerY;
          if (!pan.started) {
            if (Math.sqrt(dx * dx + dy * dy) < 4) return;
            pan.started = true;
          }
          // Free-pan overrides camera target until user focuses a module via click or minimap
          cameraCurrent.x = pan.startWorldX + dx;
          cameraCurrent.y = pan.startWorldY + dy;
          cameraTarget.x = cameraCurrent.x;
          cameraTarget.y = cameraCurrent.y;
        }
      });

      const repositionNameTag = (
        module: ModuleHandle,
        deskId: string,
        bodyX: number,
        bodyY: number,
        bodyH: number,
      ) => {
        const aid = module.deskOfAgent.get(deskId);
        if (!aid) return;
        const sprites = module.agentSprites.get(aid);
        if (!sprites) return;
        sprites.restX = bodyX;
        sprites.restY = bodyY;
        sprites.nameTag.position.set(bodyX, bodyY - bodyH - 46);
      };

      const endDrag = (ev: { global: { x: number; y: number } } | null) => {
        if (!drag) return;
        const d = drag;
        drag = null;
        const ghost = (
          d.module as ModuleHandle & { ghost: InstanceType<typeof Graphics> }
        ).ghost;
        ghost.visible = false;

        // Restore idle animation regardless of drop outcome
        const aidEnd = d.module.deskOfAgent.get(d.deskId);
        if (aidEnd) {
          const sp = d.module.agentSprites.get(aidEnd);
          if (sp) {
            sp.body.textures = idleFramesForFacing(sp.allFrames, sp.idleFacing);
            sp.body.animationSpeed = 0.08;
            sp.body.play();
          }
        }

        if (!d.started || !ev) {
          d.body.position.set(d.origX, d.origY);
          repositionNameTag(d.module, d.deskId, d.origX, d.origY, d.body.height);
          d.body.cursor = "pointer";
          // Snap desk furniture back
          const spSnap = d.module.agentSprites.get(d.module.deskOfAgent.get(d.deskId) ?? "");
          if (spSnap) {
            if (spSnap.chairSprite) spSnap.chairSprite.position.set(d.origX, d.origY - d.module.th * 0.25);
            if (spSnap.monitorSprite) {
              const deskCfgSnap = d.module.office.desks.find((dd) => dd.id === d.deskId);
              const facingSnap = deskCfgSnap?.facing ?? "S";
              const moSnap = d.module.tw * 0.8;
              spSnap.monitorSprite.position.set(
                d.origX + (facingSnap === "E" ? moSnap : facingSnap === "W" ? -moSnap : 0),
                (d.origY - d.module.th * 0.25) + (facingSnap === "S" ? moSnap : facingSnap === "N" ? -moSnap : 0),
              );
            }
          }
          return;
        }

        const localPos = d.module.container.toLocal(ev.global);
        const snapGX = Math.floor(localPos.x / d.module.tw);
        const snapGY = Math.floor(localPos.y / d.module.th);
        const inBounds =
          snapGX >= 0 &&
          snapGX < d.module.office.grid.cols &&
          snapGY >= 0 &&
          snapGY < d.module.office.grid.rows;
        const occupied = inBounds
          ? d.module.office.desks.some(
              (dd) =>
                dd.id !== d.deskId &&
                dd.gridX === snapGX &&
                dd.gridY === snapGY,
            )
          : false;
        if (!inBounds || occupied) {
          d.body.position.set(d.origX, d.origY);
          repositionNameTag(d.module, d.deskId, d.origX, d.origY, d.body.height);
          d.body.cursor = "pointer";
          // Snap desk furniture back
          const spOob = d.module.agentSprites.get(d.module.deskOfAgent.get(d.deskId) ?? "");
          if (spOob) {
            if (spOob.chairSprite) spOob.chairSprite.position.set(d.origX, d.origY - d.module.th * 0.25);
            if (spOob.monitorSprite) {
              const deskCfgOob = d.module.office.desks.find((dd) => dd.id === d.deskId);
              const facingOob = deskCfgOob?.facing ?? "S";
              const moOob = d.module.tw * 0.8;
              spOob.monitorSprite.position.set(
                d.origX + (facingOob === "E" ? moOob : facingOob === "W" ? -moOob : 0),
                (d.origY - d.module.th * 0.25) + (facingOob === "S" ? moOob : facingOob === "N" ? -moOob : 0),
              );
            }
          }
          return;
        }
        const newX = snapGX * d.module.tw + d.module.tw / 2;
        const newY = snapGY * d.module.th + d.module.th * 0.75;
        d.body.position.set(newX, newY);
        repositionNameTag(d.module, d.deskId, newX, newY, d.body.height);
        d.body.cursor = "pointer";
        const live = d.module.office.desks.find((dd) => dd.id === d.deskId);
        if (live) {
          live.gridX = snapGX;
          live.gridY = snapGY;
        }
        // Update desk furniture to new position
        const spNew = d.module.agentSprites.get(d.module.deskOfAgent.get(d.deskId) ?? "");
        if (spNew) {
          if (spNew.chairSprite) spNew.chairSprite.position.set(newX, newY - d.module.th * 0.25);
          if (spNew.monitorSprite) {
            const newFacing = live?.facing ?? "S";
            const moNew = d.module.tw * 0.8;
            spNew.monitorSprite.position.set(
              newX + (newFacing === "E" ? moNew : newFacing === "W" ? -moNew : 0),
              (newY - d.module.th * 0.25) + (newFacing === "S" ? moNew : newFacing === "N" ? -moNew : 0),
            );
          }
        }
        onAgentMoveRef.current?.(d.officeSlug, d.deskId, snapGX, snapGY);
      };

      app.stage.on("pointerup", (ev) => {
        if (drag) {
          endDrag(ev);
          return;
        }
        if (pan) pan = null;
      });
      app.stage.on("pointerupoutside", () => {
        if (drag) endDrag(null);
        if (pan) pan = null;
      });

      // Wheel zoom — cursor-centered
      const onWheel = (ev: WheelEvent) => {
        ev.preventDefault();
        const rect = app.canvas.getBoundingClientRect();
        const mx = (ev.clientX - rect.left) * (app.canvas.width / rect.width);
        const my = (ev.clientY - rect.top) * (app.canvas.height / rect.height);
        const worldXBefore = (mx - cameraCurrent.x) / cameraCurrent.scale;
        const worldYBefore = (my - cameraCurrent.y) / cameraCurrent.scale;
        const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
        const newScale = clamp(cameraCurrent.scale * factor, 0.25, 2);
        cameraCurrent.scale = newScale;
        cameraCurrent.x = mx - worldXBefore * newScale;
        cameraCurrent.y = my - worldYBefore * newScale;
        cameraTarget.scale = newScale;
        cameraTarget.x = cameraCurrent.x;
        cameraTarget.y = cameraCurrent.y;
      };
      app.canvas.addEventListener("wheel", onWheel, { passive: false });

      // ── Tick loop ────────────────────────────────────────────────────────
      let lastFocused = focusedRef.current;
      let lastSel = selectedRef.current;
      let lastBusySig = "";
      let lastStatusSig = "";
      let bobPhase = 0;
      let bloomPhase = 0;
      let orbitPhase = 0;
      let typingPhase = 0;

      const computeBusySig = () =>
        Array.from(busyRef.current).sort().join(",");
      const computeStatusSig = () =>
        Array.from(statusRef.current.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}:${v}`)
          .join(",");

      const onTick = () => {
        // Focus change → retarget camera
        if (focusedRef.current !== lastFocused) {
          lastFocused = focusedRef.current;
          refreshCameraTarget();
        }

        // Camera tween
        const ease = 0.15;
        cameraCurrent.x += (cameraTarget.x - cameraCurrent.x) * ease;
        cameraCurrent.y += (cameraTarget.y - cameraCurrent.y) * ease;
        cameraCurrent.scale +=
          (cameraTarget.scale - cameraCurrent.scale) * ease;
        world.position.set(cameraCurrent.x, cameraCurrent.y);
        world.scale.set(cameraCurrent.scale);

        // Expose for HTML drop hit-test
        geomRef.current = {
          canvas: app.canvas,
          worldScale: cameraCurrent.scale,
          worldX: cameraCurrent.x,
          worldY: cameraCurrent.y,
          modules: modules.map((m) => ({
            officeSlug: m.slug,
            offsetX: m.offsetX,
            offsetY: m.offsetY,
            tw: m.tw,
            th: m.th,
            desks: m.office.desks,
          })),
        };

        // Grid overlay toggle
        for (const m of modules) m.gridOverlay.visible = showGridRef.current;

        // Selection highlight
        if (selectedRef.current !== lastSel) {
          lastSel = selectedRef.current;
          for (const m of modules) {
            for (const [id, g] of m.deskShapes) {
              if (m.premadeRoomConfig || m.tilesheet) {
                g.alpha = id === lastSel ? 0.5 : 0;
              }
            }
          }
        }

        // Busy / status indicators + context warning
        const busySig = computeBusySig();
        const statusSig = computeStatusSig();
        if (busySig !== lastBusySig || statusSig !== lastStatusSig) {
          lastBusySig = busySig;
          lastStatusSig = statusSig;
          for (const m of modules) {
            for (const [deskId, agentId] of m.deskOfAgent) {
              const sprites = m.agentSprites.get(agentId);
              if (!sprites) continue;
              const kind = statusRef.current.get(deskId);
              const busy = busyRef.current.has(deskId);
              const isDelegating = (delegationsRef.current.get(deskId) ?? 0) > 0;
              sprites.exclamation.visible = kind === "awaiting_input";
              sprites.check.visible = kind === "done_unacked";
              sprites.pip.visible = (busy && !kind) || kind === "delegating";
              // Tint pip purple when delegating, default highlight otherwise
              if (sprites.pip.visible) {
                sprites.pip.clear();
                sprites.pip.circle(0, 0, 4).fill(isDelegating ? 0xA78BFA : m.office.theme.highlight).stroke({ color: 0x000000, width: 1 });
              }
              // Desk glow
              const glowR = Math.max(m.tw, m.th) * 0.72;
              sprites.deskGlow.clear();
              if (kind === "awaiting_input") {
                sprites.deskGlow.circle(0, 0, glowR).fill({ color: 0xFACC15, alpha: 0.22 });
              } else if (busy && isDelegating) {
                sprites.deskGlow.circle(0, 0, glowR).fill({ color: 0xA78BFA, alpha: 0.18 });
              } else if (busy) {
                sprites.deskGlow.circle(0, 0, glowR).fill({ color: 0xF59E0B, alpha: 0.18 });
              } else if (kind === "done_unacked") {
                sprites.deskGlow.circle(0, 0, glowR).fill({ color: 0x22C55E, alpha: 0.15 });
              }
              if (kind !== sprites.lastKind) {
                // Walk back to desk instead of snapping (if wandering away)
                const atDesk = Math.abs(sprites.body.x - sprites.restX) < 3 && Math.abs(sprites.body.y - sprites.restY) < 3;
                if (!atDesk && sprites.wanderTarget) {
                  // Redirect wander to head home — status anim will trigger once they arrive
                  const wdx = sprites.restX - sprites.body.x;
                  const wdy = sprites.restY - sprites.body.y;
                  const wdir: "N"|"E"|"S"|"W" = Math.abs(wdx) > Math.abs(wdy) ? (wdx > 0 ? "E" : "W") : (wdy > 0 ? "S" : "N");
                  sprites.wanderTarget = { x: sprites.restX, y: sprites.restY, dir: wdir, returning: true };
                  sprites.body.textures = sprites.allFrames[`walk${wdir}`];
                  sprites.body.animationSpeed = 0.18; // hurry back
                  sprites.body.play();
                  // Store pending status so it triggers on arrival
                  sprites.pendingKind = kind;
                  sprites.lastKind = kind;
                  continue;
                }
                if (sprites.wanderTarget) {
                  sprites.wanderTarget = null;
                  sprites.wanderTimer = 5 + Math.random() * 8;
                }
                if (kind === "done_unacked") {
                  sprites.anim = { type: "bounce", t: 0 };
                  // Spawn star particle burst
                  const starColors = [0x10b981, 0xfacc15, 0xfbbf24];
                  const count = 6 + Math.floor(Math.random() * 3);
                  for (let i = 0; i < count; i++) {
                    sprites.particles.push({
                      x: sprites.body.x,
                      y: sprites.body.y - sprites.body.height / 2,
                      vx: (Math.random() - 0.5) * 3,
                      vy: -(2 + Math.random() * 2),
                      life: 0,
                      maxLife: 0.8 + Math.random() * 0.4,
                      color: starColors[Math.floor(Math.random() * starColors.length)],
                      kind: "star",
                    });
                  }
                } else if (kind === "awaiting_input") {
                  sprites.anim = { type: "shake", t: 0 };
                } else if (kind === "error") {
                  sprites.anim = { type: "slump", t: 0 };
                  // Spawn sweat-drop particles
                  for (let i = 0; i < 2; i++) {
                    sprites.particles.push({
                      x: sprites.body.x + sprites.body.width * 0.3,
                      y: sprites.body.y - sprites.body.height * 0.8 + i * 8,
                      vx: 0.3 + Math.random() * 0.3,
                      vy: 0.5 + Math.random() * 0.5,
                      life: 0,
                      maxLife: 0.6 + Math.random() * 0.3,
                      color: 0x60a5fa,
                      kind: "sweat",
                    });
                  }
                } else {
                  sprites.anim = { type: "none", t: 0 };
                  sprites.body.x = sprites.restX;
                  sprites.body.y = sprites.restY;
                  sprites.body.scale.set(sprites.baseScaleX, sprites.baseScaleY);
                  sprites.body.skew.set(0, 0);
                }
                sprites.lastKind = kind;
              }
              // Working pose: busy but no special status (not awaiting_input, not done_unacked, not error)
              const shouldWork = busy && !kind;
              if (shouldWork && !sprites.isWorking) {
                const atDesk = Math.abs(sprites.body.x - sprites.restX) < 3 && Math.abs(sprites.body.y - sprites.restY) < 3;
                if (!atDesk && sprites.wanderTarget) {
                  // Walk back first, then enter working pose on arrival
                  const wdx = sprites.restX - sprites.body.x;
                  const wdy = sprites.restY - sprites.body.y;
                  const wdir: "N"|"E"|"S"|"W" = Math.abs(wdx) > Math.abs(wdy) ? (wdx > 0 ? "E" : "W") : (wdy > 0 ? "S" : "N");
                  sprites.wanderTarget = { x: sprites.restX, y: sprites.restY, dir: wdir, returning: true };
                  sprites.body.textures = sprites.allFrames[`walk${wdir}`];
                  sprites.body.animationSpeed = 0.18;
                  sprites.body.play();
                  sprites.pendingKind = "working";
                  continue;
                }
                sprites.isWorking = true;
                sprites.body.textures = idleFramesForFacing(sprites.allFrames, sprites.workingFacing);
                sprites.body.animationSpeed = 0.04;
                sprites.body.play();
                sprites.typingDots.visible = true;
                if (sprites.wanderTarget) {
                  sprites.wanderTarget = null;
                }
              } else if (!shouldWork && sprites.isWorking) {
                sprites.isWorking = false;
                sprites.body.textures = idleFramesForFacing(sprites.allFrames, sprites.idleFacing);
                sprites.body.animationSpeed = 0.08;
                sprites.body.play();
                sprites.typingDots.visible = false;
              }
              // Context warning overlay
              const ctxInfo = contextUsageRef.current?.get(agentId);
              sprites.ctxWarning.visible = ctxInfo
                ? isContextWarning(ctxInfo.model, ctxInfo.tokens)
                : false;
            }
          }
        }

        // Idle breathing — subtle Y bob when agent is standing still
        for (const m of modules) {
          for (const sprites of m.agentSprites.values()) {
            if (sprites.anim.type !== "none") continue;  // status anim owns Y
            if (sprites.wanderTarget) continue;          // walking owns Y
            if (drag && drag.body === sprites.body) continue;
            sprites.breathPhase += 0.03 * app.ticker.deltaTime;
            const breathY = Math.sin(sprites.breathPhase) * 1.2;
            sprites.body.y = sprites.restY + breathY;
          }
        }

        // ZZZ sleep — agents with no activity for 1+ day show floating Z's
        for (const m of modules) {
          for (const sprites of m.agentSprites.values()) {
            // Update lastRunTs when agent has any status
            if (sprites.lastKind || sprites.isWorking) {
              sprites.lastRunTs = Date.now();
            }
            const idleMs = Date.now() - sprites.lastRunTs;
            const dayMs = 24 * 60 * 60 * 1000;
            if (idleMs > dayMs && !sprites.isWorking && sprites.anim.type === "none") {
              sprites.zzzGraphics.visible = true;
              sprites.zzzPhase += 0.04 * app.ticker.deltaTime;
              sprites.zzzGraphics.clear();
              sprites.zzzGraphics.position.set(sprites.body.x, sprites.body.y);
              // Draw 3 Z's at different sizes and heights, floating upward
              for (let i = 0; i < 3; i++) {
                const phase = sprites.zzzPhase + i * 1.2;
                const floatY = -(sprites.body.height * 0.5 + 8 + i * 10 + Math.sin(phase) * 3);
                const floatX = 6 + i * 3 + Math.sin(phase * 0.7) * 2;
                const sz = 3 + i * 1.5;
                const alpha = 0.4 + 0.3 * Math.sin(phase);
                // Draw a Z shape
                sprites.zzzGraphics
                  .moveTo(floatX, floatY).lineTo(floatX + sz, floatY)
                  .lineTo(floatX, floatY + sz).lineTo(floatX + sz, floatY + sz)
                  .stroke({ color: 0xffffff, alpha, width: 1.2 });
              }
            } else {
              if (sprites.zzzGraphics.visible) {
                sprites.zzzGraphics.visible = false;
                sprites.zzzGraphics.clear();
              }
            }
          }
        }

        // Don't Call chair ambient glow — subtle pulsing edge glow on chairs
        for (const m of modules) {
          if (m.slug !== "dontcall") continue;
          for (const sprites of m.agentSprites.values()) {
            if (!sprites.chairSprite) continue;
            const pulse = 0.08 + Math.sin(bobPhase * 0.5 + sprites.breathPhase) * 0.04;
            (sprites.chairSprite as InstanceType<typeof Container>).alpha = 0.85 + pulse;
          }
        }

        // Bob indicators
        bobPhase += 0.06 * app.ticker.deltaTime;
        const bob = Math.sin(bobPhase) * 3;
        for (const m of modules) {
          for (const {
            exclamation,
            check,
            indicatorBaseY,
          } of m.agentSprites.values()) {
            if (exclamation.visible) exclamation.y = indicatorBaseY + bob;
            if (check.visible) check.y = indicatorBaseY + bob;
          }
        }

        // Typing dots animation — shown when agent is in working pose
        typingPhase += 0.05 * app.ticker.deltaTime;
        for (const m of modules) {
          for (const sprites of m.agentSprites.values()) {
            if (!sprites.typingDots.visible) continue;
            sprites.typingDots.clear();
            const offsetX = sprites.workingFacing === "E" ? 8 : sprites.workingFacing === "W" ? -8 : 0;
            const offsetY = sprites.workingFacing === "N" ? -6 : sprites.workingFacing === "S" ? 6 : -2;
            sprites.typingDots.position.set(sprites.body.x + offsetX, sprites.body.y + offsetY);
            for (let i = 0; i < 3; i++) {
              const phase = typingPhase + i * 0.7;
              const pulse = 0.5 + 0.5 * Math.abs(Math.sin(phase));
              const dotR = 1.2 * pulse;
              const alpha = 0.4 + 0.6 * pulse;
              sprites.typingDots.circle(i * 4 - 4, 0, dotR).fill({ color: 0xffffff, alpha });
            }
          }
        }

        // Delegation satellites — orbit dots around an agent for each active
        // child run they delegated. Perspective-flattened oval, slow rotation.
        orbitPhase += 0.012 * app.ticker.deltaTime;
        for (const m of modules) {
          for (const [deskId, agentId] of m.deskOfAgent) {
            const sprites = m.agentSprites.get(agentId);
            if (!sprites) continue;
            const count = delegationsRef.current.get(deskId) ?? 0;
            if (count === 0) {
              if (sprites.satellites.visible) {
                sprites.satellites.visible = false;
                sprites.satellites.clear();
              }
              sprites.lastSatCount = 0;
              continue;
            }
            sprites.satellites.visible = true;
            // Follow body during wander
            sprites.satellites.position.set(
              sprites.body.x,
              sprites.body.y - sprites.body.height / 2,
            );
            // Redraw each tick — cheap for count ≤ 6
            sprites.satellites.clear();
            const ringRx = 26;
            const ringRy = 10; // flattened for top-down camera feel
            for (let i = 0; i < count; i++) {
              const angle = orbitPhase + (i * 2 * Math.PI) / count;
              const dx = Math.cos(angle) * ringRx;
              const dy = Math.sin(angle) * ringRy;
              // Tiny shadow below the dot for depth
              sprites.satellites
                .ellipse(dx, dy + 2, 3, 1.2)
                .fill({ color: 0x000000, alpha: 0.3 });
              // Dot — subtle cyan, like a helper drone
              sprites.satellites
                .circle(dx, dy, 3)
                .fill({ color: 0x67e8f9, alpha: 0.95 });
              sprites.satellites
                .circle(dx, dy, 3)
                .stroke({ color: 0x0e7490, alpha: 0.7, width: 1 });
            }
            sprites.lastSatCount = count;
          }
        }

        // Delegation beam lines — draw animated dashes from delegator to delegate
        beamOverlay.clear();
        const links = delegationLinksRef.current;
        if (links.length > 0) {
          // Build a flat map: deskId → world-space {x, y} for all agents
          const deskWorldPos = new Map<string, { x: number; y: number }>();
          for (const m of modules) {
            for (const [deskId, agentId] of m.deskOfAgent) {
              const sp = m.agentSprites.get(agentId);
              if (!sp) continue;
              // body position is in module-local furniture space; convert to world
              const local = { x: sp.body.x, y: sp.body.y - sp.body.height / 2 };
              const worldPos = m.container.toGlobal(local);
              // world container is a child of stage — convert stage global → world local
              const worldLocal = world.toLocal(worldPos);
              deskWorldPos.set(deskId, worldLocal);
            }
          }
          const dashLen = 6;
          const gapLen = 5;
          const dotR = 2.5;
          const beamPhase = (orbitPhase * 2) % (dashLen + gapLen);

          for (const link of links) {
            const from = deskWorldPos.get(link.fromDeskId);
            const to = deskWorldPos.get(link.toDeskId);
            if (!from || !to) continue;
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 1) continue;
            const ux = dx / dist;
            const uy = dy / dist;

            // Glow backing line
            beamOverlay
              .moveTo(from.x, from.y)
              .lineTo(to.x, to.y)
              .stroke({ color: 0x67e8f9, alpha: 0.08, width: 6 });

            // Animated dashes
            let t = -beamPhase;
            while (t < dist) {
              const t0 = Math.max(0, t);
              const t1 = Math.min(dist, t + dashLen);
              if (t1 > t0) {
                beamOverlay
                  .moveTo(from.x + ux * t0, from.y + uy * t0)
                  .lineTo(from.x + ux * t1, from.y + uy * t1)
                  .stroke({ color: 0x67e8f9, alpha: 0.55, width: 1.5 });
              }
              t += dashLen + gapLen;
            }

            // Traveling dot along the beam
            const dotT = ((orbitPhase * 40) % dist + dist) % dist;
            beamOverlay
              .circle(from.x + ux * dotT, from.y + uy * dotT, dotR)
              .fill({ color: 0x67e8f9, alpha: 0.9 });

            // Endpoint glow at delegate
            beamOverlay
              .circle(to.x, to.y, 5)
              .fill({ color: 0x67e8f9, alpha: 0.15 });
          }
        }

        // Agent status animations (bounce on done, shake on awaiting input, slump on error)
        for (const m of modules) {
          for (const sprites of m.agentSprites.values()) {
            const { anim } = sprites;
            if (anim.type === "none") continue;
            // Skip while agent is being dragged
            if (drag && drag.body === sprites.body) continue;
            anim.t += app.ticker.deltaTime / 60;
            if (anim.type === "bounce") {
              // Squash-stretch hop, relative to baseScale
              const cycle = anim.t % 0.8;
              const jumpPhase = cycle / 0.8;
              const jumpH = Math.abs(Math.sin(jumpPhase * Math.PI)) * 8;
              sprites.body.y = sprites.restY - jumpH;
              if (jumpH < 1.5) {
                // Landing squash
                sprites.body.scale.x = sprites.baseScaleX * 1.12;
                sprites.body.scale.y = sprites.baseScaleY * 0.88;
              } else {
                // In-air stretch
                sprites.body.scale.x = sprites.baseScaleX * 0.95;
                sprites.body.scale.y = sprites.baseScaleY * 1.05;
              }
              // Shadow squishes as agent rises
              const shadowT = 1 - jumpH / 8;
              sprites.shadow.scale.set(0.6 + 0.4 * shadowT, 0.6 + 0.4 * shadowT);
              sprites.shadow.alpha = 0.1 + 0.18 * shadowT;
            } else if (anim.type === "shake") {
              // Gentler rocking sway
              const cycle = anim.t % 1.5;
              if (cycle < 0.6) {
                const t = cycle / 0.6;
                const sway = Math.sin(t * Math.PI * 5) * 3 * (1 - t * 0.5);
                sprites.body.x = sprites.restX + sway;
                sprites.body.y = sprites.restY - Math.abs(Math.sin(t * Math.PI * 2.5)) * 2;
              } else {
                sprites.body.x = sprites.restX;
                sprites.body.y = sprites.restY;
              }
            } else if (anim.type === "slump") {
              if (anim.t < 0.3) {
                const t = anim.t / 0.3;
                sprites.body.scale.y = sprites.baseScaleY * (1 - 0.08 * t);
                sprites.body.skew.x = 0.04 * t;
              } else if (anim.t < 2.5) {
                sprites.body.scale.y = sprites.baseScaleY * 0.92;
                sprites.body.skew.x = 0.04;
              } else if (anim.t < 3.0) {
                const t = (anim.t - 2.5) / 0.5;
                sprites.body.scale.y = sprites.baseScaleY * (0.92 + 0.08 * t);
                sprites.body.skew.x = 0.04 * (1 - t);
              } else {
                sprites.body.scale.y = sprites.baseScaleY;
                sprites.body.skew.x = 0;
                sprites.anim = { type: "none", t: 0 };
                sprites.body.scale.set(sprites.baseScaleX, sprites.baseScaleY);
                sprites.body.skew.set(0, 0);
              }
            }
          }
        }

        // Particle effects — star bursts (done_unacked) and sweat drops (error)
        for (const m of modules) {
          for (const sprites of m.agentSprites.values()) {
            if (sprites.particles.length === 0) {
              if (sprites.particleGraphics.visible) {
                sprites.particleGraphics.visible = false;
                sprites.particleGraphics.clear();
              }
              continue;
            }
            sprites.particleGraphics.visible = true;
            sprites.particleGraphics.clear();
            const dt = app.ticker.deltaTime / 60;
            sprites.particles = sprites.particles.filter((p) => {
              p.life += dt;
              if (p.life >= p.maxLife) return false;
              p.x += p.vx;
              p.y += p.vy;
              p.vy += 0.12; // gravity
              const alpha = 1 - p.life / p.maxLife;
              const sz = 2.5;
              if (p.kind === "star") {
                // Star shape using PixiJS 8 Graphics.star()
                sprites.particleGraphics
                  .star(p.x, p.y, 5, sz, sz * 0.45, 0)
                  .fill({ color: p.color, alpha });
              } else {
                sprites.particleGraphics
                  .circle(p.x, p.y, sz * 0.6)
                  .fill({ color: p.color, alpha });
              }
              return true;
            });
          }
        }

        // Idle wander — agents take a multi-leg stroll and eventually return home
        {
          const WALK_SPEED = 50; // px/s (slower, more leisurely)
          const dt = app.ticker.deltaTime / 60;

          // Pick the best walk direction for a delta
          const walkDirFor = (dx: number, dy: number): "N" | "E" | "S" | "W" => {
            if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "E" : "W";
            return dy > 0 ? "S" : "N";
          };

          for (const m of modules) {
            for (const sprites of m.agentSprites.values()) {
              if (drag && drag.body === sprites.body) continue; // dragging
              if (sprites.anim.type !== "none") continue;       // bouncing/shaking
              if (sprites.lastKind) continue;                   // has active status
              if (sprites.isWorking) continue;                  // working at desk

              if (sprites.wanderTarget) {
                const { x: tx, y: ty, returning, pause } = sprites.wanderTarget;

                // Pausing — stand and look around
                if (pause && pause > 0) {
                  sprites.wanderTarget.pause = pause - dt;
                  // Occasionally glance a random direction while paused
                  if (Math.random() < 0.01) {
                    const dirs = ["N", "E", "S", "W"] as const;
                    const look = dirs[Math.floor(Math.random() * 4)];
                    sprites.body.textures = idleFramesForFacing(sprites.allFrames, look);
                    sprites.body.animationSpeed = 0.06;
                    sprites.body.play();
                  }
                  if (sprites.wanderTarget.pause <= 0) {
                    // Done pausing — pick next leg or head home
                    const legsLeft = sprites.wanderTarget.legsLeft ?? 0;
                    if (legsLeft > 0) {
                      // Pick a new random nearby point
                      const angle = Math.random() * Math.PI * 2;
                      const dist = m.tw * (2 + Math.random() * 3);
                      const nx = sprites.body.x + Math.cos(angle) * dist;
                      const ny = sprites.body.y + Math.sin(angle) * dist;
                      // Clamp to bounds
                      const cx = Math.max(m.tw, Math.min(m.worldW - m.tw, nx));
                      const cy = Math.max(m.th, Math.min(m.worldH - m.th, ny));
                      const dir = walkDirFor(cx - sprites.body.x, cy - sprites.body.y);
                      sprites.wanderTarget = { x: cx, y: cy, dir, returning: false, legsLeft: legsLeft - 1 };
                      sprites.body.textures = sprites.allFrames[`walk${dir}`];
                      sprites.body.animationSpeed = 0.12;
                      sprites.body.play();
                    } else {
                      // Head home
                      const dir = walkDirFor(sprites.restX - sprites.body.x, sprites.restY - sprites.body.y);
                      sprites.wanderTarget = { x: sprites.restX, y: sprites.restY, dir, returning: true };
                      sprites.body.textures = sprites.allFrames[`walk${dir}`];
                      sprites.body.animationSpeed = 0.12;
                      sprites.body.play();
                    }
                  }
                  continue;
                }

                const dx = tx - sprites.body.x;
                const dy = ty - sprites.body.y;
                const dist = Math.sqrt(dx * dx + dy * dy);

                if (dist < 1.5) {
                  if (returning) {
                    // Arrived home
                    sprites.body.x = sprites.restX;
                    sprites.body.y = sprites.restY;
                    sprites.shadow.position.set(sprites.restX, sprites.restY - 2);
                    sprites.nameTag.position.set(sprites.restX, sprites.restY - sprites.body.height - 46);
                    sprites.wanderTarget = null;

                    // Trigger pending status animation if one was queued while walking back
                    const pk = sprites.pendingKind;
                    sprites.pendingKind = undefined;
                    if (pk === "working") {
                      sprites.isWorking = true;
                      sprites.body.textures = idleFramesForFacing(sprites.allFrames, sprites.workingFacing);
                      sprites.body.animationSpeed = 0.04;
                      sprites.body.play();
                      sprites.typingDots.visible = true;
                      continue;
                    } else if (pk === "done_unacked") {
                      sprites.anim = { type: "bounce", t: 0 };
                      const starColors = [0x10b981, 0xfacc15, 0xfbbf24];
                      const count = 6 + Math.floor(Math.random() * 3);
                      for (let i = 0; i < count; i++) {
                        sprites.particles.push({
                          x: sprites.restX, y: sprites.restY - sprites.body.height / 2,
                          vx: (Math.random() - 0.5) * 3, vy: -(2 + Math.random() * 2),
                          life: 0, maxLife: 0.8 + Math.random() * 0.4,
                          color: starColors[Math.floor(Math.random() * starColors.length)], kind: "star",
                        });
                      }
                    } else if (pk === "awaiting_input") {
                      sprites.anim = { type: "shake", t: 0 };
                    } else if (pk === "error") {
                      sprites.anim = { type: "slump", t: 0 };
                    }

                    sprites.body.textures = idleFramesForFacing(sprites.allFrames, sprites.idleFacing);
                    sprites.body.animationSpeed = 0.08;
                    sprites.body.play();
                    sprites.wanderTimer = 6 + Math.random() * 12;
                  } else {
                    // Arrived at waypoint — pause and look around before continuing
                    sprites.body.textures = idleFramesForFacing(sprites.allFrames, sprites.wanderTarget.dir);
                    sprites.body.animationSpeed = 0.06;
                    sprites.body.play();
                    sprites.wanderTarget.pause = 1.5 + Math.random() * 3;
                  }
                } else {
                  // Walk toward target — update facing if direction shifts significantly
                  const newDir = walkDirFor(dx, dy);
                  if (newDir !== sprites.wanderTarget.dir) {
                    sprites.wanderTarget.dir = newDir;
                    sprites.body.textures = sprites.allFrames[`walk${newDir}`];
                    sprites.body.animationSpeed = 0.12;
                    sprites.body.play();
                  }
                  const step = Math.min(WALK_SPEED * dt, dist);
                  sprites.body.x += (dx / dist) * step;
                  sprites.body.y += (dy / dist) * step;
                  sprites.shadow.position.set(sprites.body.x, sprites.body.y - 2);
                  sprites.nameTag.position.set(sprites.body.x, sprites.body.y - sprites.body.height - 46);
                }
              } else {
                sprites.wanderTimer -= dt;
                if (sprites.wanderTimer <= 0) {
                  // Start a multi-leg wander: 2-4 waypoints before returning
                  const angle = Math.random() * Math.PI * 2;
                  const dist = m.tw * (2.5 + Math.random() * 3.5);
                  const tx = sprites.body.x + Math.cos(angle) * dist;
                  const ty = sprites.body.y + Math.sin(angle) * dist;
                  // Clamp to bounds
                  const cx = Math.max(m.tw, Math.min(m.worldW - m.tw, tx));
                  const cy = Math.max(m.th, Math.min(m.worldH - m.th, ty));
                  const dir = walkDirFor(cx - sprites.restX, cy - sprites.restY);
                  const legs = 1 + Math.floor(Math.random() * 3); // 1-3 more stops after this one
                  sprites.wanderTarget = { x: cx, y: cy, dir, returning: false, legsLeft: legs };
                  sprites.body.textures = sprites.allFrames[`walk${dir}`];
                  sprites.body.animationSpeed = 0.12;
                  sprites.body.play();
                }
              }
            }
          }
        }

        // Social encounters — wandering agents that get close face each other and chat
        for (const m of modules) {
          const wanderers = [...m.agentSprites.values()].filter(
            (s) => s.wanderTarget && !s.wanderTarget.returning && s.wanderTarget.pause && s.wanderTarget.pause > 0
          );
          // Also check walking agents that haven't paused yet
          const walkers = [...m.agentSprites.values()].filter(
            (s) => s.wanderTarget && !s.wanderTarget.returning && !s.wanderTarget.pause && !s.isWorking && s.anim.type === "none"
          );
          const allWanderers = [...wanderers, ...walkers];
          for (let i = 0; i < allWanderers.length; i++) {
            for (let j = i + 1; j < allWanderers.length; j++) {
              const a = allWanderers[i];
              const b = allWanderers[j];
              const dx = a.body.x - b.body.x;
              const dy = a.body.y - b.body.y;
              const dist = Math.sqrt(dx * dx + dy * dy);
              const chatRange = m.tw * 2.5;
              if (dist < chatRange && dist > 1) {
                // Face each other
                const dirAtoB: "N"|"E"|"S"|"W" = Math.abs(dx) > Math.abs(dy)
                  ? (dx < 0 ? "E" : "W") : (dy < 0 ? "S" : "N");
                const dirBtoA: "N"|"E"|"S"|"W" = Math.abs(dx) > Math.abs(dy)
                  ? (dx < 0 ? "W" : "E") : (dy < 0 ? "N" : "S");
                // Only trigger if both aren't already chatting (check if paused facing each other)
                const aAlreadyChatting = a.wanderTarget?.pause && a.wanderTarget.pause > 2;
                const bAlreadyChatting = b.wanderTarget?.pause && b.wanderTarget.pause > 2;
                if (!aAlreadyChatting && !bAlreadyChatting) {
                  // Stop both and face each other
                  a.body.textures = idleFramesForFacing(a.allFrames, dirAtoB);
                  a.body.animationSpeed = 0.06;
                  a.body.play();
                  if (a.wanderTarget) a.wanderTarget.pause = 3 + Math.random() * 3;

                  b.body.textures = idleFramesForFacing(b.allFrames, dirBtoA);
                  b.body.animationSpeed = 0.06;
                  b.body.play();
                  if (b.wanderTarget) b.wanderTarget.pause = 3 + Math.random() * 3;

                  // Show emote on one of them (random pick)
                  const talker = Math.random() < 0.5 ? a : b;
                  talker.emoteTimer = 2.0;
                }
              }
            }
          }
        }

        // Emote bubble rendering — small speech icon above chatting agents
        {
          const dt = app.ticker.deltaTime / 60;
          for (const m of modules) {
            for (const sprites of m.agentSprites.values()) {
              if (sprites.emoteTimer > 0) {
                sprites.emoteTimer -= dt;
                sprites.emoteGraphics.visible = true;
                sprites.emoteGraphics.clear();
                sprites.emoteGraphics.position.set(
                  sprites.body.x + 8,
                  sprites.body.y - sprites.body.height - 12,
                );
                const alpha = Math.min(1, sprites.emoteTimer * 2);
                // Small speech bubble with "!" or "♪" feel
                const bw = 10, bh = 8;
                sprites.emoteGraphics
                  .roundRect(-bw / 2, -bh / 2, bw, bh, 2)
                  .fill({ color: 0xffffff, alpha: alpha * 0.9 })
                  .stroke({ color: 0x000000, alpha: alpha * 0.3, width: 0.5 });
                // Tail
                sprites.emoteGraphics
                  .moveTo(-1, bh / 2).lineTo(-3, bh / 2 + 3).lineTo(1, bh / 2)
                  .fill({ color: 0xffffff, alpha: alpha * 0.9 });
                // Exclamation dot inside
                sprites.emoteGraphics
                  .rect(-0.8, -3, 1.6, 4).fill({ color: 0x333333, alpha })
                  .circle(0, 3, 0.8).fill({ color: 0x333333, alpha });
              } else if (sprites.emoteGraphics.visible) {
                sprites.emoteGraphics.visible = false;
                sprites.emoteGraphics.clear();
              }
            }
          }
        }

        // Subtle bloom pulse when a module is focused
        bloomPhase += 0.01 * app.ticker.deltaTime;
        bloom.bloomScale =
          0.15 + Math.sin(bloomPhase) * 0.02 + (focusedRef.current ? 0.03 : 0);

        // Emit agent positions for ambient bubbles (every ~30 frames)
        if (onAgentPositionsRef.current && Math.round(bloomPhase * 10) % 30 === 0) {
          const rect = app.canvas.getBoundingClientRect();
          const sx = rect.width / app.canvas.width;
          const sy = rect.height / app.canvas.height;
          const posMap = new Map<string, { clientX: number; clientY: number }>();
          for (const m of modules) {
            for (const [agentId, sprites] of m.agentSprites) {
              const globalPos = sprites.body.getGlobalPosition();
              posMap.set(agentId, {
                clientX: rect.left + globalPos.x * sx,
                clientY: rect.top + (globalPos.y - sprites.body.height - 8) * sy,
              });
            }
          }
          onAgentPositionsRef.current(posMap);
        }
      };
      app.ticker.add(onTick);

      cleanup = () => {
        app.ticker.remove(onTick);
        app.renderer.off("resize", onResize);
        app.canvas.removeEventListener("wheel", onWheel);
        document.removeEventListener("dragstart", onHtmlDragStart);
        document.removeEventListener("dragend", onHtmlDragEnd);
        for (const m of modules) {
          for (const { body } of m.agentSprites.values()) body.stop();
        }
        app.destroy(true, { children: true });
        geomRef.current.canvas = null;
      };
    })();

    return () => {
      destroyed = true;
      cleanup?.();
    };
    // Mount once; props flow via refs. The station config is treated as static.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // HTML drop hit-test across all modules
  const hitTestDesk = (
    clientX: number,
    clientY: number,
  ): { officeSlug: string; deskId: string } | null => {
    const g = geomRef.current;
    if (!g.canvas) return null;
    const rect = g.canvas.getBoundingClientRect();
    const px = (clientX - rect.left) * (g.canvas.width / rect.width);
    const py = (clientY - rect.top) * (g.canvas.height / rect.height);
    // Invert world transform
    const wx = (px - g.worldX) / g.worldScale;
    const wy = (py - g.worldY) / g.worldScale;

    let best: { officeSlug: string; deskId: string; d: number } | null = null;
    for (const m of g.modules) {
      const lx = wx - m.offsetX;
      const ly = wy - m.offsetY;
      const gx = Math.floor(lx / m.tw);
      const gy = Math.floor(ly / m.th);
      for (const desk of m.desks) {
        const dx = gx - desk.gridX;
        const dy = gy - desk.gridY;
        const d = Math.abs(dx) + Math.abs(dy);
        if (d <= 1 && (!best || d < best.d)) {
          best = { officeSlug: m.officeSlug, deskId: desk.id, d };
        }
      }
    }
    return best ? { officeSlug: best.officeSlug, deskId: best.deskId } : null;
  };

  const onDragOver: React.DragEventHandler<HTMLDivElement> = (e) => {
    if (!onDeskDrop) return;
    if (e.dataTransfer.types.includes("application/x-robot-task")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  };

  const onDrop: React.DragEventHandler<HTMLDivElement> = (e) => {
    if (!onDeskDrop) return;
    const hasTask = e.dataTransfer.types.includes("application/x-robot-task");
    if (!hasTask) return;
    e.preventDefault();
    const hit = hitTestDesk(e.clientX, e.clientY);
    if (hit) onDeskDrop(hit.officeSlug, hit.deskId, e);
  };

  return (
    <div
      className="relative w-full h-full"
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div ref={hostRef} className="absolute inset-0" />
    </div>
  );
}

function hexToInt(hex: string): number {
  return parseInt(hex.replace("#", ""), 16);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
