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
        threshold: 0.55,
        bloomScale: 0.85,
        brightness: 1.0,
        blur: 4,
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
        indicatorBaseY: number;
        agentId: string;
        model: string | null;
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
        fontSize: 9,
        fill: 0xffffff,
        stroke: { color: 0x000000, width: 3, join: "round" },
      });

      const buildNameTag = (name: string) => {
        const c = new Container();
        const label = new Text({ text: name, style: nameTagStyle });
        label.anchor.set(0.5, 0.5);
        const padX = 5;
        const padY = 2;
        const w = Math.ceil(label.width) + padX * 2;
        const h = Math.ceil(label.height) + padY * 2;
        const bg = new Graphics()
          .roundRect(-w / 2, -h / 2, w, h, 4)
          .fill({ color: 0x000000, alpha: 0.7 })
          .stroke({ color: 0xffffff, alpha: 0.25, width: 1 });
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
          .map((a) => `/sprites/characters/${a.visual.premade}`)
          .filter(Boolean);
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

        // War-room click cells (one per room with `warRoom` set)
        for (const room of office.rooms) {
          if (!room.warRoom) continue;
          const wx = room.warRoom.gridX;
          const wy = room.warRoom.gridY;
          const { x, y } = flat(wx, wy);
          const wzBase = wy * office.grid.cols + wx;

          const cell = new Graphics();
          cell
            .roundRect(2, 2, tw - 4, th - 4, 4)
            .fill({ color: glowColor, alpha: 0.4 })
            .stroke({ color: glowColor, width: 2, alpha: 1 });
          cell.position.set(x, y);
          cell.eventMode = "static";
          cell.cursor = "pointer";
          cell.zIndex = wzBase + 2;
          const slug = office.slug;
          cell.on("pointertap", (ev) => {
            onWarRoomClickRef.current?.(slug);
            ev.stopPropagation();
          });
          furniture.addChild(cell);

          const warTag = buildNameTag("WAR ROOM");
          warTag.position.set(x + tw / 2, y - 4);
          warTag.zIndex = wzBase + 7;
          warTag.eventMode = "static";
          warTag.cursor = "pointer";
          warTag.on("pointertap", (ev) => {
            onWarRoomClickRef.current?.(slug);
            ev.stopPropagation();
          });
          furniture.addChild(warTag);
        }

        // Agents
        const agentSprites = new Map<string, AgentSprites>();
        const deskOfAgent = new Map(office.agents.map((a) => [a.deskId, a.id]));

        const moduleHandleForBody = {} as ModuleHandle; // forward-declared so pointerdown closures capture it

        for (const agent of office.agents) {
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
          body.position.set(agentCenterX, agentBottomY);
          const zBase = desk.gridY * office.grid.cols + desk.gridX;
          body.zIndex = zBase + 3;
          body.eventMode = "static";
          body.cursor = "pointer";
          const deskId = desk.id;
          const officeSlug = office.slug;
          body.on("pointertap", (ev) => {
            emitAgentClick(officeSlug, deskId, body);
            ev.stopPropagation();
          });
          body.on("pointerdown", (ev) => {
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
          furniture.addChild(body);

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

          const nameTag = buildNameTag(agent.name);
          const nameTagY = agentBottomY - body.height - 4;
          nameTag.position.set(agentCenterX, nameTagY);
          nameTag.zIndex = zBase + 7;
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

          agentSprites.set(agent.id, {
            body,
            pip,
            exclamation,
            check,
            ctxWarning,
            nameTag,
            indicatorBaseY,
            agentId: agent.id,
            model: agent.model ?? null,
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
          if (ev.target === moduleContainer || ev.target === roomBg || ev.target === roomFg) {
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
        modules.push(handle);
      }

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
        // Only fire if the tap landed on the stage itself, not a module/sprite
        if (ev.target === app.stage) {
          onSelectRef.current?.(null);
        }
      });

      // Camera pan: pointerdown on empty stage, pointermove pans
      app.stage.on("pointerdown", (ev) => {
        if (drag) return;
        if (ev.target !== app.stage) return;
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
                localPos.y - drag.body.height - 4,
              );
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
        sprites.nameTag.position.set(bodyX, bodyY - bodyH - 4);
      };

      const endDrag = (ev: { global: { x: number; y: number } } | null) => {
        if (!drag) return;
        const d = drag;
        drag = null;
        const ghost = (
          d.module as ModuleHandle & { ghost: InstanceType<typeof Graphics> }
        ).ghost;
        ghost.visible = false;

        if (!d.started || !ev) {
          d.body.position.set(d.origX, d.origY);
          repositionNameTag(d.module, d.deskId, d.origX, d.origY, d.body.height);
          d.body.cursor = "pointer";
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
              sprites.exclamation.visible = kind === "awaiting_input";
              sprites.check.visible = kind === "done_unacked";
              sprites.pip.visible = busy && !kind;
              // Context warning overlay
              const ctxInfo = contextUsageRef.current?.get(agentId);
              sprites.ctxWarning.visible = ctxInfo
                ? isContextWarning(ctxInfo.model, ctxInfo.tokens)
                : false;
            }
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

        // Subtle bloom pulse when a module is focused
        bloomPhase += 0.01 * app.ticker.deltaTime;
        bloom.bloomScale =
          0.8 + Math.sin(bloomPhase) * 0.08 + (focusedRef.current ? 0.1 : 0);

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
