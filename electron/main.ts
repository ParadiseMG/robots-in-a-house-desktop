/**
 * Electron main process for "Robots in a House"
 *
 * Responsibilities:
 *   1. Launch the compiled Next.js app (next start, port 3000)
 *   2. Launch the compiled agent-runner (node electron/agent-runner.js, port 3101)
 *   3. Wait for Next.js to be ready, then open a BrowserWindow
 *   4. Gracefully shut down both child processes on exit
 */

import { app, BrowserWindow, dialog, Tray, Menu, nativeImage, Notification, ipcMain } from "electron";
import { spawn, ChildProcess } from "node:child_process";
import * as http from "node:http";
import * as path from "node:path";
import * as fs from "node:fs";
import { autoUpdater } from "electron-updater";

// ---- PATH augmentation -------------------------------------------------------
// Ensure system package managers (homebrew) are reachable even when Electron
// is launched from the Finder / Dock (where $PATH is minimal).
const EXTRA_PATHS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
const currentPath = process.env.PATH ?? "";
process.env.PATH = [
  ...EXTRA_PATHS.filter((p) => !currentPath.includes(p)),
  currentPath,
].join(":");

// ---- State -------------------------------------------------------------------
let nextProcess: ChildProcess | null = null;
let runnerProcess: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

// Root of the packaged app (or the project root in dev)
const APP_ROOT = path.join(__dirname, "..");

// ---- Persistent data directory ------------------------------------------------
// Store mutable data (db, configs, workspaces) in userData so it survives app
// updates. On first launch, seed from the bundled defaults.
const DATA_DIR = path.join(app.getPath("userData"), "app-data");

function seedDataDir() {
  const marker = path.join(DATA_DIR, ".seeded");
  // Always ensure the data dir and subdirs exist
  for (const sub of ["config", "data", "agent-workspaces"]) {
    fs.mkdirSync(path.join(DATA_DIR, sub), { recursive: true });
  }

  if (fs.existsSync(marker)) return; // already seeded

  console.log(`[main] seeding data dir: ${DATA_DIR}`);

  // Copy bundled config/*.office.json → DATA_DIR/config/
  const bundledConfig = path.join(APP_ROOT, "config");
  if (fs.existsSync(bundledConfig)) {
    for (const file of fs.readdirSync(bundledConfig)) {
      if (!file.endsWith(".office.json")) continue;
      const dest = path.join(DATA_DIR, "config", file);
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(path.join(bundledConfig, file), dest);
      }
    }
  }

  // Copy bundled agent-workspaces/ → DATA_DIR/agent-workspaces/
  const bundledWorkspaces = path.join(APP_ROOT, "agent-workspaces");
  if (fs.existsSync(bundledWorkspaces)) {
    copyDirRecursive(bundledWorkspaces, path.join(DATA_DIR, "agent-workspaces"));
  }

  // Note: we do NOT copy data/robots.db — the app creates it fresh via migrate()
  // and seedIfEmpty(). This avoids shipping stale dev data.

  fs.writeFileSync(marker, new Date().toISOString(), "utf-8");
  console.log("[main] data dir seeded.");
}

/** Recursively copy a directory, skipping files that already exist at dest. */
function copyDirRecursive(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (!fs.existsSync(destPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ---- Child process helpers ---------------------------------------------------

/** Spawn next start on port 3200 using Electron's own Node binary.
 *  This ensures both processes load native modules (better-sqlite3)
 *  compiled against the same NODE_MODULE_VERSION. */
function startNext(): ChildProcess {
  const nextCli = path.join(APP_ROOT, "node_modules", "next", "dist", "bin", "next");
  const proc = spawn(process.execPath, [nextCli, "start", "--port", "3200"], {
    cwd: APP_ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", RIAH_DATA_DIR: DATA_DIR },
    stdio: "pipe",
  });

  proc.stdout?.on("data", (d: Buffer) =>
    console.log("[next]", d.toString().trimEnd())
  );
  proc.stderr?.on("data", (d: Buffer) =>
    console.error("[next]", d.toString().trimEnd())
  );
  proc.on("exit", (code, signal) => {
    console.log(`[next] exited code=${code} signal=${signal}`);
    nextProcess = null;
  });
  proc.on("error", (err) => {
    console.error("[next] failed to start:", err.message);
  });

  return proc;
}

/** Spawn the compiled agent-runner on port 3101 (overridable via RUNNER_PORT) */
function startRunner(): ChildProcess {
  const runnerJs = path.join(__dirname, "agent-runner.js");
  const proc = spawn(process.execPath, [runnerJs], {
    cwd: APP_ROOT,
    env: { ...process.env, RIAH_DATA_DIR: DATA_DIR },
    stdio: "pipe",
  });

  proc.stdout?.on("data", (d: Buffer) =>
    console.log("[runner]", d.toString().trimEnd())
  );
  proc.stderr?.on("data", (d: Buffer) =>
    console.error("[runner]", d.toString().trimEnd())
  );
  proc.on("exit", (code, signal) => {
    console.log(`[runner] exited code=${code} signal=${signal}`);
    runnerProcess = null;
  });
  proc.on("error", (err) => {
    console.error("[runner] failed to start:", err.message);
  });

  return proc;
}

/**
 * Poll http://localhost:3000 until it responds 200 (or until timeout).
 * Retries every 500 ms, gives up after 30 s.
 */
function waitForNext(
  maxMs = 30_000,
  intervalMs = 500
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function attempt() {
      const req = http.get("http://localhost:3200", (res) => {
        res.resume(); // drain so the socket closes
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - start >= maxMs) {
          reject(new Error("Timed out waiting for Next.js on port 3200"));
        } else {
          setTimeout(attempt, intervalMs);
        }
      });
      req.setTimeout(intervalMs, () => {
        req.destroy();
        setTimeout(attempt, intervalMs);
      });
    }
    attempt();
  });
}

/** Send SIGTERM; escalate to SIGKILL after `gracePeriodMs` if still alive */
function killGracefully(proc: ChildProcess | null, gracePeriodMs = 5000) {
  if (!proc || proc.killed || proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (!proc.killed && proc.exitCode === null) {
      console.warn("Escalating to SIGKILL");
      proc.kill("SIGKILL");
    }
  }, gracePeriodMs);
  // Don't keep the Electron process alive just for this timer
  if (typeof timer.unref === "function") timer.unref();
}

// ---- Auto-updater -----------------------------------------------------------

function setupAutoUpdater() {
  // Don't auto-download — just notify. Unsigned apps can't do silent install.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("update-available", (info) => {
    console.log(`[updater] update available: v${info.version}`);
    dialog
      .showMessageBox({
        type: "info",
        title: "Update Available",
        message: `Robots in a House v${info.version} is available.`,
        detail: "Download and install now? The app will restart when complete.",
        buttons: ["Download & Install", "Later"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.downloadUpdate();
        }
      });
  });

  autoUpdater.on("update-downloaded", () => {
    console.log("[updater] update downloaded — prompting restart");
    dialog
      .showMessageBox({
        type: "info",
        title: "Update Ready",
        message: "Update downloaded. Restart now to apply?",
        buttons: ["Restart", "Later"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
  });

  autoUpdater.on("error", (err) => {
    console.error("[updater] error:", err.message);
    // Silently fail — don't bother the user if update check fails
  });

  // Check once on launch, then every 4 hours
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(
    () => autoUpdater.checkForUpdates().catch(() => {}),
    4 * 60 * 60 * 1000
  );
}

// ---- IPC handlers -----------------------------------------------------------

function setupIPC() {
  ipcMain.handle("app:get-version", () => {
    return app.getVersion();
  });

  ipcMain.handle("app:get-data-dir", () => {
    return DATA_DIR;
  });

  ipcMain.handle("app:check-for-updates", async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      if (result && result.updateInfo) {
        return {
          available: result.updateInfo.version !== app.getVersion(),
          version: result.updateInfo.version,
        };
      }
      return { available: false };
    } catch {
      return null;
    }
  });
}

// ---- Notification preferences -----------------------------------------------

interface NotificationPrefs {
  enabled: boolean;
  onAgentDone: boolean;
  onAgentError: boolean;
  onAwaitingInput: boolean;
  // Don't re-notify for runs we've already notified about
  _notifiedRunIds?: string[];
}

const DEFAULT_PREFS: NotificationPrefs = {
  enabled: true,
  onAgentDone: true,
  onAgentError: true,
  onAwaitingInput: true,
};

const PREFS_PATH = path.join(app.getPath("userData"), "notification-prefs.json");

function loadPrefs(): NotificationPrefs {
  try {
    const raw = fs.readFileSync(PREFS_PATH, "utf8");
    return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs(prefs: NotificationPrefs) {
  const { _notifiedRunIds, ...toSave } = prefs;
  fs.writeFileSync(PREFS_PATH, JSON.stringify(toSave, null, 2));
}

// ---- System tray ------------------------------------------------------------

function createTray() {
  const iconPath = path.join(APP_ROOT, "build", "icon.png");
  let trayIcon = nativeImage.createFromPath(iconPath);
  // macOS tray icons should be ~22px; resize if needed
  trayIcon = trayIcon.resize({ width: 22, height: 22 });

  tray = new Tray(trayIcon);
  tray.setToolTip("Robots in a House");

  updateTrayMenu();

  tray.on("click", () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
      }
    }
  });
}

function updateTrayMenu() {
  if (!tray) return;
  const prefs = loadPrefs();

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show Window",
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    { type: "separator" },
    {
      label: "Notifications",
      submenu: [
        {
          label: "Enabled",
          type: "checkbox",
          checked: prefs.enabled,
          click: (item) => {
            prefs.enabled = item.checked;
            savePrefs(prefs);
          },
        },
        { type: "separator" },
        {
          label: "Agent finished",
          type: "checkbox",
          checked: prefs.onAgentDone,
          click: (item) => {
            prefs.onAgentDone = item.checked;
            savePrefs(prefs);
          },
        },
        {
          label: "Agent error",
          type: "checkbox",
          checked: prefs.onAgentError,
          click: (item) => {
            prefs.onAgentError = item.checked;
            savePrefs(prefs);
          },
        },
        {
          label: "Agent needs input",
          type: "checkbox",
          checked: prefs.onAwaitingInput,
          click: (item) => {
            prefs.onAwaitingInput = item.checked;
            savePrefs(prefs);
          },
        },
      ],
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

// ---- Agent status notifications ---------------------------------------------

let lastPollTime = Date.now();
const notifiedRunIds = new Set<string>();
let notificationPollInterval: ReturnType<typeof setInterval> | null = null;

function startNotificationPoller() {
  // Poll every 5 seconds
  notificationPollInterval = setInterval(pollAgentStatus, 5_000);
}

function pollAgentStatus() {
  const prefs = loadPrefs();
  if (!prefs.enabled) return;

  const since = lastPollTime;
  lastPollTime = Date.now();

  const req = http.get(
    `http://127.0.0.1:3101/runs/recent?since=${since}`,
    (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk; });
      res.on("end", () => {
        try {
          const runs = JSON.parse(data) as Array<{
            id: string;
            agent_id: string;
            office_slug: string;
            status: string;
            error?: string;
          }>;

          for (const run of runs) {
            if (notifiedRunIds.has(run.id)) continue;

            if (run.status === "done" && prefs.onAgentDone) {
              notifiedRunIds.add(run.id);
              fireNotification(
                `${run.agent_id} finished`,
                `Task complete in ${run.office_slug}`,
                run
              );
            } else if (run.status === "error" && prefs.onAgentError) {
              notifiedRunIds.add(run.id);
              fireNotification(
                `${run.agent_id} hit an error`,
                run.error ?? "Unknown error",
                run
              );
            } else if (run.status === "awaiting_input" && prefs.onAwaitingInput) {
              notifiedRunIds.add(run.id);
              fireNotification(
                `${run.agent_id} needs input`,
                `Waiting for your reply in ${run.office_slug}`,
                run
              );
            }
          }

          // Keep notifiedRunIds from growing forever
          if (notifiedRunIds.size > 500) {
            const arr = Array.from(notifiedRunIds);
            arr.splice(0, arr.length - 200);
            notifiedRunIds.clear();
            arr.forEach((id) => notifiedRunIds.add(id));
          }
        } catch {
          // Runner not ready or bad response — ignore
        }
      });
    }
  );
  req.on("error", () => {}); // runner not up yet
  req.setTimeout(3000, () => req.destroy());
}

function fireNotification(
  title: string,
  body: string,
  run: { id: string; agent_id: string; office_slug: string }
) {
  const n = new Notification({ title, body });
  n.on("click", () => {
    // Bring window to front when notification is clicked
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  n.show();
}

// ---- App lifecycle -----------------------------------------------------------

app.on("ready", async () => {
  console.log("[main] app ready — starting services…");

  // Ensure persistent data dir exists and is seeded with bundled defaults
  seedDataDir();

  // Register IPC handlers for renderer bridge
  setupIPC();

  // Show splash screen immediately
  splashWindow = new BrowserWindow({
    width: 320,
    height: 280,
    frame: false,
    transparent: false,
    resizable: false,
    alwaysOnTop: true,
    center: true,
    backgroundColor: "#1a1a2e",
    webPreferences: { contextIsolation: true },
  });
  splashWindow.loadFile(path.join(__dirname, "splash.html"));
  splashWindow.on("closed", () => { splashWindow = null; });

  // Launch both services immediately
  nextProcess = startNext();
  runnerProcess = startRunner();

  // Wait for Next.js before opening the window
  try {
    console.log("[main] waiting for Next.js…");
    await waitForNext();
    console.log("[main] Next.js ready — opening window");
  } catch (err) {
    console.error("[main] Next.js never became ready:", err);
    // Still open the window — it will show a connection error the user can refresh
  }

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "Robots in a House",
    show: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadURL("http://localhost:3200");

  // Show main window once content has painted, then close splash
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
    }
    // Check for updates after the app is visible
    setupAutoUpdater();
  });

  // Hide to tray instead of closing (macOS pattern)
  mainWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Set up system tray and notifications
  createTray();
  startNotificationPoller();
});

app.on("window-all-closed", () => {
  // On macOS, keep running in tray. On other platforms, quit.
  if (process.platform !== "darwin") {
    isQuitting = true;
    killGracefully(nextProcess);
    killGracefully(runnerProcess);
    app.quit();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  if (notificationPollInterval) clearInterval(notificationPollInterval);
  killGracefully(nextProcess);
  killGracefully(runnerProcess);
});

// Re-open the window on macOS when clicking the dock icon
app.on("activate", () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else if (app.isReady()) {
    // Services are already running — just reopen the window
    mainWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      title: "Robots in a House",
      webPreferences: {
        contextIsolation: true,
      },
    });
    mainWindow.loadURL("http://localhost:3200");
    mainWindow.on("close", (e) => {
      if (!isQuitting) {
        e.preventDefault();
        mainWindow?.hide();
      }
    });
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
  }
});
