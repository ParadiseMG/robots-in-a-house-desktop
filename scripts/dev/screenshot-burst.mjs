#!/usr/bin/env node
/**
 * Take rapid burst screenshots to catch animation frame issues.
 */
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto("http://localhost:3000/sprite-maker", { waitUntil: "networkidle", timeout: 15000 });
await page.waitForTimeout(3000); // let initial composite finish

// Take 8 screenshots over ~2 seconds
for (let i = 0; i < 8; i++) {
  await page.screenshot({ path: `/tmp/cc-burst-${i}.png` });
  await page.waitForTimeout(250);
}

console.log("Burst screenshots saved");
await browser.close();
