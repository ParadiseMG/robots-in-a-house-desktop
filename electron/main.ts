/**
 * Electron main process for "Robots in a House"
 *
 * Responsibilities:
 *   1. Launch the compiled Next.js app (next start, port 3000)
 *   2. Launch the compiled agent-runner (node electron/agent-runner.js, port 3101)
 *   3. Wait for Next.js to be ready, then open a BrowserWindow
 *   4. Gracefully shut down both child processes on exit
 */

import { app, BrowserWindow, dialog } from "electron";
import { spawn, ChildProcess } from "node:child_process";
import * as http from "node:http";
import * as path from "node:path";
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

// Root of the packaged app (or the project root in dev)
const APP_ROOT = path.join(__dirname, "..");

// ---- Child process helpers ---------------------------------------------------

/** Spawn next start on port 3200 using Electron's own Node binary.
 *  This ensures both processes load native modules (better-sqlite3)
 *  compiled against the same NODE_MODULE_VERSION. */
function startNext(): ChildProcess {
  const nextCli = path.join(APP_ROOT, "node_modules", "next", "dist", "bin", "next");
  const proc = spawn(process.execPath, [nextCli, "start", "--port", "3200"], {
    cwd: APP_ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
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
    env: { ...process.env },
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

// ---- App lifecycle -----------------------------------------------------------

app.on("ready", async () => {
  console.log("[main] app ready — starting services…");

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

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
});

app.on("window-all-closed", () => {
  console.log("[main] all windows closed — shutting down services");
  killGracefully(nextProcess);
  killGracefully(runnerProcess);
  app.quit();
});

app.on("before-quit", () => {
  killGracefully(nextProcess);
  killGracefully(runnerProcess);
});

// Re-open the window on macOS when clicking the dock icon
app.on("activate", () => {
  if (mainWindow === null && app.isReady()) {
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
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
  }
});
