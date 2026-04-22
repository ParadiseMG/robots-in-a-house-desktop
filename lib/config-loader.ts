import fs from "node:fs";
import path from "node:path";
import type { OfficeConfig, RoomTemplate } from "./office-types";

const CONFIG_DIR = path.join(process.cwd(), "config");
const TEMPLATES_DIR = path.join(CONFIG_DIR, "templates");

// ─── In-memory config cache ─────────────────────────────────────────────────
// Avoids re-reading JSON from disk on every getAgent() / loadOfficeConfig() call.
// Invalidated by fs.watch on the config directory.

const _officeCache = new Map<string, { config: OfficeConfig; mtime: number }>();
let _watcherStarted = false;

function startConfigWatcher() {
  if (_watcherStarted) return;
  _watcherStarted = true;
  try {
    fs.watch(CONFIG_DIR, { persistent: false }, (_event, filename) => {
      if (!filename || !filename.endsWith(".office.json")) return;
      const slug = filename.replace(".office.json", "");
      _officeCache.delete(slug);
    });
  } catch {
    // Watcher failed (e.g. CI, missing dir) — cache still works,
    // just won't auto-invalidate. Manual writes via saveOfficeConfig
    // or instantiateTemplate already invalidate below.
  }
}

/** Force-invalidate a cached office config (call after writes). */
export function invalidateOfficeCache(slug?: string) {
  if (slug) {
    _officeCache.delete(slug);
  } else {
    _officeCache.clear();
  }
}

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
 * Load a single office config from disk (cached). Returns null if not found.
 * Cache is invalidated automatically by fs.watch or manually via invalidateOfficeCache().
 */
export function loadOfficeConfig(slug: string): OfficeConfig | null {
  startConfigWatcher();

  const filePath = path.join(CONFIG_DIR, `${slug}.office.json`);

  try {
    const stat = fs.statSync(filePath);
    const mtime = stat.mtimeMs;

    const cached = _officeCache.get(slug);
    if (cached && cached.mtime === mtime) {
      return cached.config;
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    const config = JSON.parse(raw) as OfficeConfig;
    _officeCache.set(slug, { config, mtime });
    return config;
  } catch {
    _officeCache.delete(slug);
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

// ─── Room Templates ──────────────────────────────────────────────────────────

/**
 * List all available room template IDs from config/templates/*.json.
 */
export function listTemplateIds(): string[] {
  try {
    return fs
      .readdirSync(TEMPLATES_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(".json", ""))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Load a single room template by ID.
 */
export function loadTemplate(id: string): RoomTemplate | null {
  try {
    const raw = fs.readFileSync(
      path.join(TEMPLATES_DIR, `${id}.json`),
      "utf-8",
    );
    return JSON.parse(raw) as RoomTemplate;
  } catch {
    return null;
  }
}

/**
 * Load all room templates from disk.
 */
export function loadAllTemplates(): RoomTemplate[] {
  return listTemplateIds()
    .map(loadTemplate)
    .filter((t): t is RoomTemplate => t !== null);
}

/**
 * Instantiate a new OfficeConfig from a template.
 *
 * Takes a template ID, a slug for the new office, a display name,
 * and an optional accent color. Creates the office JSON on disk
 * with empty agents and desk IDs derived from the slug.
 */
export function instantiateTemplate(
  templateId: string,
  slug: string,
  name: string,
  accent?: string,
): OfficeConfig {
  const template = loadTemplate(templateId);
  if (!template) throw new Error(`Template not found: ${templateId}`);

  // Validate slug
  if (!slug || /[^a-z0-9-]/.test(slug)) {
    throw new Error(`Invalid slug: "${slug}" — use lowercase letters, numbers, hyphens only`);
  }
  if (isValidOfficeSlug(slug)) {
    throw new Error(`Office "${slug}" already exists`);
  }

  // Build desk configs from template slots
  const desks = template.desks.map((slot, i) => ({
    id: `desk-${slug}-${i}`,
    roomId: template.rooms[0]?.id ?? "main",
    gridX: slot.gridX,
    gridY: slot.gridY,
    facing: slot.facing,
    ...(slot.label ? { label: slot.label } : {}),
  }));

  // Build room configs (add groupchat to the first room)
  const rooms = template.rooms.map((r, i) => ({
    ...r,
    ...(i === 0
      ? {
          groupchat: {
            gridX: Math.floor((r.gridX + r.w) / 2),
            gridY: Math.floor((r.gridY + r.h) / 2),
          },
        }
      : {}),
  }));

  // Apply accent override to theme if provided
  const theme = { ...template.theme };
  if (accent) {
    theme.accent = accent;
  }

  const office: OfficeConfig = {
    slug,
    name,
    theme,
    tile: template.tile,
    grid: template.grid,
    rooms,
    desks,
    agents: [],
  };

  // Write to disk and invalidate cache
  const filePath = path.join(CONFIG_DIR, `${slug}.office.json`);
  fs.writeFileSync(filePath, JSON.stringify(office, null, 2) + "\n");
  invalidateOfficeCache(slug);

  return office;
}

/**
 * Delete an office config from disk and optionally remove from station.json.
 * Returns the deleted config (for agent retention) or null if not found.
 * Does NOT delete agent-workspaces directories — those are retained.
 */
export function deleteOffice(
  slug: string,
  removeFromStation = true,
): OfficeConfig | null {
  const config = loadOfficeConfig(slug);
  if (!config) return null;

  // Remove config file and invalidate cache
  const filePath = path.join(CONFIG_DIR, `${slug}.office.json`);
  try {
    fs.unlinkSync(filePath);
    invalidateOfficeCache(slug);
  } catch {
    return null;
  }

  // Remove from station.json
  if (removeFromStation) {
    const stationPath = path.join(CONFIG_DIR, "station.json");
    try {
      const raw = fs.readFileSync(stationPath, "utf-8");
      const station = JSON.parse(raw);
      station.modules = (station.modules || []).filter(
        (m: { office: string }) => m.office !== slug,
      );
      fs.writeFileSync(stationPath, JSON.stringify(station, null, 2) + "\n");
    } catch {
      // station.json missing or malformed — skip
    }
  }

  return config;
}
