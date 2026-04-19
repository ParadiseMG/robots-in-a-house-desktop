/**
 * LimeZu Modern Interiors — sprite loading utilities for PixiJS 8.
 *
 * ─── Premade Character sheet layout (verified by inspection) ────────────────
 *
 * File:  public/sprites/characters/premade_XX.png
 * Size:  896 × 656 px  →  56 cols × 41 tile-rows at 16 × 16 px per tile.
 *
 * Each character sprite occupies TWO tile-rows (32 px tall, 16 px wide).
 * Row-pairs are counted from the top:
 *
 *   Pair 0  (pixel rows   0–31):  4 frames  — preview / unlabeled
 *   Pair 1  (pixel rows  32–63): 24 frames  — IDLE  (4 dirs × 6 frames)
 *   Pair 2  (pixel rows  64–95): 24 frames  — WALK  (4 dirs × 6 frames)
 *   Pair 3+ (pixel rows 96–639): remaining animations
 *            (sleep, sit×2, phone, swim loop, push-cart, pick-up, gift,
 *             lift, throw, hit, punch, stab, grab/sun, gun-idle, shoot, hurt)
 *
 * Within a 24-frame idle/walk group, directions are arranged as:
 *   cols  0– 5  →  East   (character faces right)
 *   cols  6–11  →  North  (character faces away)
 *   cols 12–17  →  West   (character faces left)
 *   cols 18–23  →  South  (character faces viewer)
 *
 * ─── Interior tilesheet layout ──────────────────────────────────────────────
 *
 * File:  public/sprites/interiors/XXXX.png
 * Tiles are arranged in a grid with the tileSize specified at load time
 * (always 16 for the Theme_Sorter sheets used here).
 * Tile coordinates are [col, row] 0-indexed from the top-left.
 *
 * ─── SSR safety ─────────────────────────────────────────────────────────────
 *
 * pixi.js is browser-only. All pixi imports are done inside async functions
 * via `await import("pixi.js")`, never at module top-level.
 */

import type { Texture, Rectangle } from "pixi.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type PremadeFrames = {
  /** Source texture (full sheet). */
  texture: Texture;
  /** Directional animation frame groups. */
  frames: {
    /** South — character faces the viewer. */
    idleS: Texture[];
    /** North — character faces away from the viewer. */
    idleN: Texture[];
    /** West — character faces left. */
    idleW: Texture[];
    /** East — character faces right. */
    idleE: Texture[];
    walkS: Texture[];
    walkN: Texture[];
    walkW: Texture[];
    walkE: Texture[];
  };
};

export type Tilesheet = {
  texture: Texture;
  tileSize: number;
  /** Returns the texture for tile at [col, row]. */
  getTile(col: number, row: number): Texture;
};

// ─── Constants ───────────────────────────────────────────────────────────────

const SPRITE_W = 16;
const SPRITE_H = 16;
/** Each character is 2 tile-rows tall. */
const SPRITE_ROWS = 2;
const SPRITE_HEIGHT_PX = SPRITE_H * SPRITE_ROWS; // 32px

/** Pixel-row of the sheet where idle pair starts. */
const IDLE_PAIR_Y = 1 * SPRITE_HEIGHT_PX; // row-pair 1 → y = 32

/** Pixel-row of the sheet where walk pair starts. */
const WALK_PAIR_Y = 2 * SPRITE_HEIGHT_PX; // row-pair 2 → y = 64

const FRAMES_PER_DIR = 6;

/** Column offsets for each direction within a 24-frame group. */
const DIR_COL_OFFSETS = {
  S: 18,
  N: 6,
  W: 12,
  E: 0,
} as const;

// ─── Internal caches ─────────────────────────────────────────────────────────

const premadeCache = new Map<string, Promise<PremadeFrames>>();
const tilesheetCache = new Map<string, Promise<Tilesheet>>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Slice N frames from a loaded texture.
 * Requires the PixiJS Rectangle constructor passed from the async context
 * where pixi.js was dynamically imported.
 */
function sliceFrames(
  sheet: Texture,
  startX: number,
  startY: number,
  count: number,
  RectangleCtor: new (x: number, y: number, width: number, height: number) => Rectangle
): Texture[] {
  const frames: Texture[] = [];
  for (let i = 0; i < count; i++) {
    const tex = new (sheet.constructor as typeof Texture)({
      source: sheet.source,
      frame: new RectangleCtor(
        startX + i * SPRITE_W,
        startY,
        SPRITE_W,
        SPRITE_HEIGHT_PX
      ),
    });
    frames.push(tex);
  }
  return frames;
}

/**
 * Slice one directional group (FRAMES_PER_DIR frames) from an animation row-pair.
 */
function sliceDir(
  sheet: Texture,
  pairY: number,
  dir: keyof typeof DIR_COL_OFFSETS,
  RectangleCtor: new (x: number, y: number, width: number, height: number) => Rectangle
): Texture[] {
  const startX = DIR_COL_OFFSETS[dir] * SPRITE_W;
  return sliceFrames(sheet, startX, pairY, FRAMES_PER_DIR, RectangleCtor);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Load a LimeZu premade character sheet and return sliced animation frames.
 *
 * @param path  Path relative to /public — e.g. "/sprites/characters/premade_03.png"
 *
 * Results are cached: multiple agents sharing the same premade pay only one
 * network request.
 */
export async function loadPremade(path: string): Promise<PremadeFrames> {
  if (premadeCache.has(path)) return premadeCache.get(path)!;

  const promise = (async (): Promise<PremadeFrames> => {
    const { Assets, Rectangle: Rect } = await import("pixi.js");
    const texture = (await Assets.load(path)) as Texture;

    return {
      texture,
      frames: {
        idleS: sliceDir(texture, IDLE_PAIR_Y, "S", Rect),
        idleN: sliceDir(texture, IDLE_PAIR_Y, "N", Rect),
        idleW: sliceDir(texture, IDLE_PAIR_Y, "W", Rect),
        idleE: sliceDir(texture, IDLE_PAIR_Y, "E", Rect),
        walkS: sliceDir(texture, WALK_PAIR_Y, "S", Rect),
        walkN: sliceDir(texture, WALK_PAIR_Y, "N", Rect),
        walkW: sliceDir(texture, WALK_PAIR_Y, "W", Rect),
        walkE: sliceDir(texture, WALK_PAIR_Y, "E", Rect),
      },
    };
  })();

  premadeCache.set(path, promise);
  return promise;
}

/**
 * Get the idle frames for a given facing direction.
 * Convenience wrapper for renderer code.
 */
export function idleFramesForFacing(
  frames: PremadeFrames["frames"],
  facing: "N" | "E" | "S" | "W"
): Texture[] {
  return frames[`idle${facing}`] ?? frames.idleS;
}

/**
 * Load an interior tilesheet and return a helper for extracting individual tiles.
 *
 * @param path      Path relative to /public — e.g. "/sprites/interiors/fishing_16x16.png"
 * @param tileSize  Tile size in pixels (16 for all Theme_Sorter sheets).
 *
 * Results are cached by path+tileSize.
 */
export async function loadTilesheet(
  path: string,
  tileSize: number
): Promise<Tilesheet> {
  const cacheKey = `${path}:${tileSize}`;
  if (tilesheetCache.has(cacheKey)) return tilesheetCache.get(cacheKey)!;

  const promise = (async (): Promise<Tilesheet> => {
    const { Assets, Rectangle: Rect } = await import("pixi.js");
    const texture = (await Assets.load(path)) as Texture;

    const tileCache = new Map<string, Texture>();

    function getTile(col: number, row: number): Texture {
      const key = `${col},${row}`;
      if (tileCache.has(key)) return tileCache.get(key)!;
      const tex = new (texture.constructor as typeof Texture)({
        source: texture.source,
        frame: new Rect(col * tileSize, row * tileSize, tileSize, tileSize),
      });
      tileCache.set(key, tex);
      return tex;
    }

    return { texture, tileSize, getTile };
  })();

  tilesheetCache.set(cacheKey, promise);
  return promise;
}

/**
 * Preload all unique premade paths referenced by an office config.
 * Call this once after app.init() before building any sprites.
 *
 * @param premadePaths  Array of /public-relative paths, may contain duplicates.
 */
export async function preloadPremades(premadePaths: string[]): Promise<void> {
  const unique = [...new Set(premadePaths)];
  await Promise.all(unique.map((p) => loadPremade(p)));
}
