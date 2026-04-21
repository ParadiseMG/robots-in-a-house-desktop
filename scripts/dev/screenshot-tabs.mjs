#!/usr/bin/env node
/**
 * Screenshot each tab of the sprite maker.
 */
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto("http://localhost:3000/sprite-maker", { waitUntil: "networkidle", timeout: 15000 });
await page.waitForTimeout(3000);

// Screenshot default (Body tab)
await page.screenshot({ path: "/tmp/cc-tab-body.png" });

// Click each tab and screenshot
const tabs = ["Eyes", "Outfit", "Hair", "Accessory"];
for (const tab of tabs) {
  await page.click(`button:has-text("${tab}")`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `/tmp/cc-tab-${tab.toLowerCase()}.png` });
}

// Also try randomize
await page.click('button:has-text("Randomize")');
await page.waitForTimeout(2000);
await page.screenshot({ path: "/tmp/cc-randomized.png" });

console.log("All screenshots saved");
await browser.close();
