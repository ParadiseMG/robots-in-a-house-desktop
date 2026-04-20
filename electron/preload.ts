/**
 * Preload script — runs in renderer context before page code.
 * Exposes a safe `window.electronAPI` bridge via contextBridge.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  /** App version from package.json */
  getVersion: (): Promise<string> => ipcRenderer.invoke("app:get-version"),

  /** Trigger an update check. Returns update info or null. */
  checkForUpdates: (): Promise<{ available: boolean; version?: string } | null> =>
    ipcRenderer.invoke("app:check-for-updates"),

  /** Get the persistent data directory path */
  getDataDir: (): Promise<string> => ipcRenderer.invoke("app:get-data-dir"),

  /** Whether we're running inside Electron */
  isElectron: true,
});
