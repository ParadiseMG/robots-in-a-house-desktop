import path from "node:path";

/**
 * Resolve persistent data directories.
 *
 * In the Electron desktop app, RIAH_DATA_DIR is set to the userData folder
 * (~/Library/Application Support/Robots in a House/) so data survives updates.
 *
 * In web dev mode (no env var), falls back to process.cwd() — the repo root.
 */
const DATA_ROOT = process.env.RIAH_DATA_DIR || process.cwd();

/** Directory containing *.office.json config files */
export const CONFIG_DIR = path.join(DATA_ROOT, "config");

/** Directory containing robots.db */
export const DB_DIR = path.join(DATA_ROOT, "data");

/** Full path to the SQLite database */
export const DB_PATH = path.join(DB_DIR, "robots.db");

/** Directory for agent workspaces (CLAUDE.md, MEMORY.md per agent) */
export const WORKSPACES_DIR = path.join(DATA_ROOT, "agent-workspaces");
