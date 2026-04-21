/**
 * Build the Ops Center "Bunker" room from LimeZu tilesheets.
 *
 * Reads: basement_16x16.png (256x800, 16x50 tiles)
 * Writes: public/sprites/interiors/premade_rooms/ops_bunker_v2_layer1.png
 *         public/sprites/interiors/premade_rooms/ops_bunker_v2_layer2.png
 *
 * Room: 384x288 = 24x18 tiles at 16px
 *
 * Run: node scripts/build-ops-room.mjs
 */

import sharp from "sharp";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const TILE = 16;
const COLS = 24;
const ROWS = 18;
const W = COLS * TILE; // 384
const H = ROWS * TILE; // 288

const BASEMENT = join(ROOT, "public/sprites/interiors/basement_16x16.png");
const OUT_DIR = join(ROOT, "public/sprites/interiors/premade_rooms");

// ---- Helpers ----

async function extractTile(sheetPath, col, row) {
  return sharp(sheetPath)
    .extract({ left: col * TILE, top: row * TILE, width: TILE, height: TILE })
    .toBuffer();
}

function solidTile(hex) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  const buf = Buffer.alloc(TILE * TILE * 4);
  for (let i = 0; i < TILE * TILE; i++) {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = 255;
  }
  return sharp(buf, { raw: { width: TILE, height: TILE, channels: 4 } })
    .png()
    .toBuffer();
}

// ---- Build Layer 1 (below characters) ----

async function buildLayer1() {
  const composites = [];
  const place = (buf, gx, gy) => {
    composites.push({ input: buf, left: gx * TILE, top: gy * TILE });
  };
  const bTile = async (tCol, tRow, gx, gy) => {
    place(await extractTile(BASEMENT, tCol, tRow), gx, gy);
  };

  // === FLOOR ===
  // Dark walls around perimeter, dark floor interior
  for (let gy = 0; gy < ROWS; gy++) {
    for (let gx = 0; gx < COLS; gx++) {
      const isWall = gy === 0 || gy === ROWS - 1 || gx === 0 || gx === COLS - 1;
      const isTrim = gy === 1 || gy === ROWS - 2 || gx === 1 || gx === COLS - 2;

      if (isWall) {
        place(await solidTile("#101014"), gx, gy);
      } else if (isTrim) {
        // Blue accent trim along inner wall
        place(await solidTile("#15202e"), gx, gy);
      } else {
        // Floor — subtle checkerboard
        const dark = (gx + gy) % 2 === 0;
        place(await solidTile(dark ? "#25252c" : "#2b2b34"), gx, gy);
      }
    }
  }

  // Corner accent dots (bright blue)
  for (const [cx, cy] of [[1, 1], [COLS - 2, 1], [1, ROWS - 2], [COLS - 2, ROWS - 2]]) {
    place(await solidTile("#2674d4"), cx, cy);
  }

  // Center aisle highlight (slightly different floor tone)
  for (let gy = 3; gy < ROWS - 3; gy++) {
    place(await solidTile("#222230"), 11, gy);
    place(await solidTile("#222230"), 12, gy);
  }

  // === NORTH WALL: "THE BIG BOARD" ===
  // Central large monitor — basement row 28-29, col 0-3 (big blue-screen TV)
  // This is a 4x2 tile large monitor
  for (let tc = 0; tc < 4; tc++) {
    await bTile(tc, 28, 10 + tc, 1); // top half
    await bTile(tc, 29, 10 + tc, 2); // bottom half
  }

  // Left screen pair — basement row 28-29, col 4-5 (medium dark monitors)
  await bTile(4, 28, 4, 1);
  await bTile(5, 28, 5, 1);
  await bTile(4, 29, 4, 2);
  await bTile(5, 29, 5, 2);

  // Second left screen
  await bTile(6, 28, 7, 1);
  await bTile(7, 28, 8, 1);
  await bTile(6, 29, 7, 2);
  await bTile(7, 29, 8, 2);

  // Right screen pair
  await bTile(4, 28, 15, 1);
  await bTile(5, 28, 16, 1);
  await bTile(4, 29, 15, 2);
  await bTile(5, 29, 16, 2);

  // Second right screen
  await bTile(6, 28, 18, 1);
  await bTile(7, 28, 19, 1);
  await bTile(6, 29, 18, 2);
  await bTile(7, 29, 19, 2);

  // Far-edge small wall monitors (row 28-29, col 10-11 = dark wall-mount screens)
  await bTile(10, 28, 2, 1);
  await bTile(10, 29, 2, 2);
  await bTile(10, 28, 21, 1);
  await bTile(10, 29, 21, 2);

  // === COMMAND TIER (rows 3-4) — Captain, Shell, Switch face the Big Board ===
  // Desktop monitors + chairs at command positions
  const commandStations = [6, 11, 16]; // Switch, Captain, Shell grid-x
  for (const gx of commandStations) {
    await bTile(12, 30, gx, 3);          // monitor (dark style for command)
    await bTile(4, 33, gx, 4);           // chair
  }

  // === WORKSTATION ROW 1 (rows 5-6) ===
  // Desktop monitors: basement row 30, col 12 and 14
  // Chairs: basement row 33, col 4 and 6
  const stations1 = [3, 5, 7, 10, 13, 16, 18, 20]; // grid-x positions
  for (const gx of stations1) {
    const monCol = gx % 2 === 0 ? 12 : 14; // alternate monitor styles
    await bTile(monCol, 30, gx, 5);       // monitor
    await bTile(4, 33, gx, 6);            // chair
  }

  // === WORKSTATION ROW 2 (rows 9-10) — Mid tier ===
  const stations2 = [3, 5, 8, 10, 13, 15, 18, 20];
  for (const gx of stations2) {
    const monCol = gx % 2 === 0 ? 14 : 12;
    await bTile(monCol, 30, gx, 9);
    await bTile(6, 33, gx, 10);           // different chair style
  }

  // === WORKSTATION ROW 3 (rows 13-14) — Back tier ===
  const stations3 = [4, 5, 7, 10, 13, 16, 19]; // added gx=5 for Hammer
  for (const gx of stations3) {
    const monCol = gx % 2 === 0 ? 12 : 14;
    await bTile(monCol, 30, gx, 13);
    await bTile(4, 33, gx, 14);
  }

  // === SIDE EQUIPMENT ===
  // Arcade cabinets as "server terminals" along side walls
  // Basement row 42-43 has arcade cabs (2 tiles tall)
  // Blue arcade: col 0-1, row 42-43
  // Gold arcade: col 2-3, row 42-43

  // Left wall equipment
  await bTile(0, 42, 2, 4);
  await bTile(0, 43, 2, 5);
  await bTile(2, 42, 2, 8);
  await bTile(2, 43, 2, 9);
  await bTile(0, 42, 2, 12);
  await bTile(0, 43, 2, 13);

  // Right wall equipment
  await bTile(1, 42, 21, 4);
  await bTile(1, 43, 21, 5);
  await bTile(3, 42, 21, 8);
  await bTile(3, 43, 21, 9);
  await bTile(1, 42, 21, 12);
  await bTile(1, 43, 21, 13);

  // === SOUTH WALL EQUIPMENT ===
  // Server racks / equipment along bottom wall
  // Using arcade cabs as server-like equipment
  for (let gx = 4; gx < COLS - 4; gx += 4) {
    await bTile(0, 42, gx, ROWS - 4);
    await bTile(1, 42, gx + 1, ROWS - 4);
    await bTile(0, 43, gx, ROWS - 3);
    await bTile(1, 43, gx + 1, ROWS - 3);
  }

  // === BUILD ===
  const base = sharp({
    create: { width: W, height: H, channels: 4, background: { r: 16, g: 16, b: 20, alpha: 255 } },
  }).png();

  const outPath = join(OUT_DIR, "ops_bunker_v2_layer1.png");
  await base.composite(composites).toFile(outPath);
  console.log(`Layer 1: ${outPath}`);
}

// ---- Build Layer 2 (above characters) ----

async function buildLayer2() {
  const composites = [];
  const place = (buf, gx, gy) => {
    composites.push({ input: buf, left: gx * TILE, top: gy * TILE });
  };

  // Overhead ceiling lights — subtle blue-white glow dots
  const makeLightTile = async (size, alpha) => {
    const buf = Buffer.alloc(TILE * TILE * 4, 0);
    const half = TILE / 2;
    const hs = size / 2;
    for (let dy = half - hs; dy < half + hs; dy++) {
      for (let dx = half - hs; dx < half + hs; dx++) {
        const idx = (dy * TILE + dx) * 4;
        buf[idx] = 160;
        buf[idx + 1] = 190;
        buf[idx + 2] = 255;
        buf[idx + 3] = alpha;
      }
    }
    return sharp(buf, { raw: { width: TILE, height: TILE, channels: 4 } }).png().toBuffer();
  };

  const light = await makeLightTile(6, 140);
  const lightDim = await makeLightTile(4, 80);

  // Main lights grid — denser coverage
  for (let gy = 3; gy < ROWS - 3; gy += 3) {
    for (let gx = 4; gx < COLS - 3; gx += 4) {
      place(light, gx, gy);
    }
  }
  // Fill lights between mains
  for (let gy = 5; gy < ROWS - 3; gy += 3) {
    for (let gx = 6; gx < COLS - 3; gx += 4) {
      place(lightDim, gx, gy);
    }
  }

  // Horizontal conduit pipes (visible dark lines with blue tint)
  const makePipeTile = async () => {
    const buf = Buffer.alloc(TILE * TILE * 4, 0);
    for (let dx = 0; dx < TILE; dx++) {
      // 4px wide pipe with highlight edge
      for (const dy of [6, 7, 8, 9]) {
        const idx = (dy * TILE + dx) * 4;
        const isEdge = dy === 6 || dy === 9;
        buf[idx] = isEdge ? 45 : 25;
        buf[idx + 1] = isEdge ? 55 : 30;
        buf[idx + 2] = isEdge ? 75 : 45;
        buf[idx + 3] = isEdge ? 50 : 90;
      }
    }
    return sharp(buf, { raw: { width: TILE, height: TILE, channels: 4 } }).png().toBuffer();
  };
  const pipe = await makePipeTile();

  // Three pipe runs across the ceiling
  for (const pipeRow of [4, 8, 14]) {
    for (let gx = 2; gx < COLS - 2; gx++) {
      place(pipe, gx, pipeRow);
    }
  }

  const base = sharp({
    create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).png();

  const outPath = join(OUT_DIR, "ops_bunker_v2_layer2.png");
  await base.composite(composites).toFile(outPath);
  console.log(`Layer 2: ${outPath}`);
}

async function main() {
  console.log(`Building Ops Bunker v2: ${W}x${H} (${COLS}x${ROWS} tiles at ${TILE}px)`);
  await buildLayer1();
  await buildLayer2();
  console.log("Done.");
}

main().catch((err) => { console.error(err); process.exit(1); });
