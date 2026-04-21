#!/usr/bin/env node
/**
 * Render each individual idle frame from a composite to check for blanks.
 */
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto("http://localhost:3000/sprite-maker", { waitUntil: "networkidle", timeout: 15000 });
await page.waitForTimeout(4000);

// Extract each of the 6 south-facing idle frames from the composite sheet
const frameData = await page.evaluate(() => {
  const TILE = 16;
  const CHAR_W = 16;
  const CHAR_H = 32;
  const IDLE_PAIR_Y = 32;
  const SOUTH_COL = 18;
  const FRAMES = 6;

  // Get the composite sheet from the page's state
  // We'll create our own composite to test
  const results = [];

  // Load images and composite
  return new Promise(async (resolve) => {
    const base = "/sprites/characters/generator";

    async function loadImg(src) {
      return new Promise((res, rej) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => res(img);
        img.onerror = rej;
        img.src = src;
      });
    }

    // Build composite
    const sheet = document.createElement("canvas");
    sheet.width = 896;
    sheet.height = 656;
    const ctx = sheet.getContext("2d");
    ctx.imageSmoothingEnabled = false;

    const body = await loadImg(`${base}/bodies/Body_01.png`);
    ctx.drawImage(body, -16, 0);
    const eyes = await loadImg(`${base}/eyes/Eyes_01.png`);
    ctx.drawImage(eyes, 0, 0);
    const outfit = await loadImg(`${base}/outfits/Outfit_01_01.png`);
    ctx.drawImage(outfit, 0, 0);
    const hair = await loadImg(`${base}/hairstyles/Hairstyle_01_01.png`);
    ctx.drawImage(hair, 0, 0);

    // Now extract each frame
    const frameResults = [];
    for (let f = 0; f < FRAMES; f++) {
      const fc = document.createElement("canvas");
      fc.width = CHAR_W * 6;
      fc.height = CHAR_H * 6;
      const fctx = fc.getContext("2d");
      fctx.imageSmoothingEnabled = false;

      const sx = (SOUTH_COL + f) * TILE;
      fctx.drawImage(sheet, sx, IDLE_PAIR_Y, CHAR_W, CHAR_H, 0, 0, CHAR_W * 6, CHAR_H * 6);

      // Check if frame has any non-transparent pixels
      const imgData = fctx.getImageData(0, 0, fc.width, fc.height);
      let nonTransparent = 0;
      for (let i = 3; i < imgData.data.length; i += 4) {
        if (imgData.data[i] > 0) nonTransparent++;
      }

      frameResults.push({
        frame: f,
        col: SOUTH_COL + f,
        nonTransparentPixels: nonTransparent,
        totalPixels: fc.width * fc.height,
        dataUrl: fc.toDataURL(),
      });
    }

    resolve(frameResults);
  });
});

console.log("\nIdle frame analysis (South-facing, row-pair 1):");
for (const f of frameData) {
  const pct = ((f.nonTransparentPixels / f.totalPixels) * 100).toFixed(1);
  console.log(`  Frame ${f.frame} (col ${f.col}): ${f.nonTransparentPixels} opaque pixels (${pct}%)`);
}

await browser.close();
