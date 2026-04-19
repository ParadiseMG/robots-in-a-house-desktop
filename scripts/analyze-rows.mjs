#!/usr/bin/env node
/** Check which row-pairs have content in a generator sheet */
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
await page.goto("http://localhost:3000/sprite-maker", { waitUntil: "networkidle", timeout: 15000 });
await page.waitForTimeout(2000);

const results = await page.evaluate(async () => {
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "/sprites/characters/generator/outfits/Outfit_01_01.png"; });

  const canvas = document.createElement("canvas");
  canvas.width = img.width; canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  const TILE = 16;
  const PAIR_H = 32;
  const S_COL = 18;
  const rows = [];

  for (let rp = 0; rp < 20; rp++) {
    const y = rp * PAIR_H;
    if (y + PAIR_H > img.height) break;
    // Check south-facing first frame
    const data = ctx.getImageData(S_COL * TILE, y, TILE, PAIR_H);
    let opaque = 0;
    for (let i = 3; i < data.data.length; i += 4) { if (data.data[i] > 0) opaque++; }
    rows.push({ rowPair: rp, y, opaquePixels: opaque });
  }
  return rows;
});

console.log("Row-pair analysis (Outfit_01_01.png, south-facing col 18):");
for (const r of results) {
  const label = r.opaquePixels > 10 ? "HAS CONTENT" : "empty";
  console.log(`  Row-pair ${r.rowPair.toString().padStart(2)} (y=${r.y.toString().padStart(3)}): ${r.opaquePixels.toString().padStart(4)} px  ${label}`);
}

await browser.close();
