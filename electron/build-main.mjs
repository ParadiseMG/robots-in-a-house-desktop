/**
 * esbuild script — compiles Electron main process and agent-runner to CJS.
 *
 * Outputs:
 *   electron/main.js         — Electron main process (CJS, node platform)
 *   electron/agent-runner.js — Bundled agent-runner (CJS, node platform)
 *
 * Externals:
 *   better-sqlite3  — native addon; must be loaded from node_modules at runtime
 *   @anthropic-ai/claude-agent-sdk — spawns subprocesses; must not be bundled
 *
 * Everything else (db.ts, lib/agent-builder.ts, lib/model-context.ts, etc.)
 * is bundled inline so the output files are self-contained.
 */

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, ".."); // project root

/** Shared config for both builds */
const sharedConfig = {
  platform: "node",
  format: "cjs",
  bundle: true,
  sourcemap: true,
  target: "node20",
  // native addons + subprocess-based SDKs must stay external
  external: [
    "better-sqlite3",
    "@anthropic-ai/claude-agent-sdk",
    // electron itself is only used in main.ts; mark it external there too
    "electron",
    // electron-updater must stay external — uses electron APIs at runtime
    "electron-updater",
  ],
  // Resolve .js extensions to their .ts source during the build
  // (TypeScript files import each other as .js — esbuild handles this)
  resolveExtensions: [".ts", ".js", ".json"],
};

// ---- 1. Electron main process ------------------------------------------------
console.log("Building electron/main.ts → electron/main.js …");
await build({
  ...sharedConfig,
  entryPoints: [join(__dirname, "main.ts")],
  outfile: join(__dirname, "main.js"),
});
console.log("  done.");

// ---- 2. Preload script -------------------------------------------------------
console.log("Building electron/preload.ts → electron/preload.js …");
await build({
  ...sharedConfig,
  entryPoints: [join(__dirname, "preload.ts")],
  outfile: join(__dirname, "preload.js"),
});
console.log("  done.");

// ---- 3. Agent runner ---------------------------------------------------------
console.log("Building server/agent-runner.ts → electron/agent-runner.js …");
await build({
  ...sharedConfig,
  entryPoints: [join(ROOT, "server", "agent-runner.ts")],
  outfile: join(__dirname, "agent-runner.js"),
  // json imports (office configs) — let esbuild inline them
  loader: { ".json": "json" },
});
console.log("  done.");

console.log("Build complete.");
