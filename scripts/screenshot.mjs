#!/usr/bin/env node
/**
 * Take a headless screenshot of a local page.
 * Usage: node scripts/screenshot.mjs [url] [output]
 * Defaults: url = http://localhost:3000, output = /tmp/cc-screenshot.png
 */
import { chromium } from "playwright";

const url = process.argv[2] || "http://localhost:3000";
const output = process.argv[3] || "/tmp/cc-screenshot.png";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

try {
  await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
  // Wait extra for canvas rendering / async image loads
  await page.waitForTimeout(4000);
  await page.screenshot({ path: output, fullPage: false });
  console.log(`Screenshot saved to ${output}`);
} catch (err) {
  console.error("Screenshot failed:", err.message);
  process.exit(1);
} finally {
  await browser.close();
}
// test
