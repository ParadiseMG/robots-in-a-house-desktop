/**
 * Type-safe access to the Electron preload bridge.
 *
 * In the browser (web dev mode), window.electronAPI is undefined.
 * In the Electron app, it's injected by electron/preload.ts via contextBridge.
 */

export interface ElectronAPI {
  getVersion: () => Promise<string>;
  checkForUpdates: () => Promise<{ available: boolean; version?: string } | null>;
  getDataDir: () => Promise<string>;
  isElectron: true;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

/** Returns the electron API if running inside Electron, null otherwise. */
export function getElectronAPI(): ElectronAPI | null {
  if (typeof window !== "undefined" && window.electronAPI) {
    return window.electronAPI;
  }
  return null;
}
