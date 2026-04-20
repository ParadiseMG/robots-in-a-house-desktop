import fs from "node:fs";
import path from "node:path";
import type { OfficeConfig } from "./office-types";
import { CONFIG_DIR } from "./data-paths";


/**
 * Discover all office slugs by scanning config/ for *.office.json files.
 * Returns slugs sorted alphabetically.
 */
export function listOfficeSlugs(): string[] {
  try {
    return fs
      .readdirSync(CONFIG_DIR)
      .filter((f) => f.endsWith(".office.json"))
      .map((f) => f.replace(".office.json", ""))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Check if a slug has a corresponding config file on disk.
 */
export function isValidOfficeSlug(slug: string): boolean {
  if (!slug || /[^a-zA-Z0-9_-]/.test(slug)) return false;
  const filePath = path.join(CONFIG_DIR, `${slug}.office.json`);
  return fs.existsSync(filePath);
}

/**
 * Load a single office config from disk. Returns null if not found.
 */
export function loadOfficeConfig(slug: string): OfficeConfig | null {
  try {
    const raw = fs.readFileSync(
      path.join(CONFIG_DIR, `${slug}.office.json`),
      "utf-8",
    );
    return JSON.parse(raw) as OfficeConfig;
  } catch {
    return null;
  }
}

/**
 * Load all office configs from disk.
 */
export function loadAllOffices(): Record<string, OfficeConfig> {
  const result: Record<string, OfficeConfig> = {};
  for (const slug of listOfficeSlugs()) {
    const config = loadOfficeConfig(slug);
    if (config) result[slug] = config;
  }
  return result;
}
