"use client";

import { useCallback, useEffect, useState } from "react";
import { getElectronAPI } from "@/lib/electron-api";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function SettingsPanel({ open, onClose }: Props) {
  const electron = getElectronAPI();

  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<
    "idle" | "checking" | "available" | "up-to-date" | "error"
  >("idle");
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [dataDir, setDataDir] = useState<string | null>(null);

  // Load app info on mount
  useEffect(() => {
    if (!electron) return;
    electron.getVersion().then(setAppVersion).catch(() => {});
    electron.getDataDir().then(setDataDir).catch(() => {});
  }, [electron]);

  const checkForUpdates = useCallback(async () => {
    if (!electron) return;
    setUpdateStatus("checking");
    try {
      const result = await electron.checkForUpdates();
      if (!result) {
        setUpdateStatus("error");
        return;
      }
      if (result.available) {
        setUpdateStatus("available");
        setLatestVersion(result.version ?? null);
      } else {
        setUpdateStatus("up-to-date");
      }
    } catch {
      setUpdateStatus("error");
    }
  }, [electron]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed left-3 top-14 z-50 w-80 rounded-lg border border-white/10 bg-gray-950 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <span className="font-mono text-sm font-medium">Settings</span>
          <button
            onClick={onClose}
            className="rounded p-1 text-white/40 transition hover:bg-white/10 hover:text-white"
          >
            <svg width="14" height="14" viewBox="0 0 14 14">
              <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="2" />
            </svg>
          </button>
        </div>

        <div className="flex flex-col gap-0.5 p-2">
          {/* Updates section */}
          <Section title="Updates">
            {electron ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs text-white/50">
                    Current version
                  </span>
                  <span className="font-mono text-xs">
                    {appVersion ? `v${appVersion}` : "..."}
                  </span>
                </div>

                <button
                  onClick={checkForUpdates}
                  disabled={updateStatus === "checking"}
                  className="flex items-center justify-center gap-2 rounded-md border border-white/10 bg-white/5 px-3 py-2 font-mono text-xs transition hover:bg-white/10 disabled:opacity-50"
                >
                  {updateStatus === "checking" ? (
                    <>
                      <Spinner />
                      Checking...
                    </>
                  ) : (
                    "Check for updates"
                  )}
                </button>

                {updateStatus === "available" && (
                  <div className="rounded-md border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 font-mono text-xs text-cyan-400">
                    v{latestVersion} available — the app will prompt you to
                    download it.
                  </div>
                )}
                {updateStatus === "up-to-date" && (
                  <div className="rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 font-mono text-xs text-green-400">
                    You're on the latest version.
                  </div>
                )}
                {updateStatus === "error" && (
                  <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 font-mono text-xs text-red-400">
                    Couldn't check for updates. Try again later.
                  </div>
                )}
              </div>
            ) : (
              <div className="font-mono text-xs text-white/30">
                Auto-updates are only available in the desktop app.
              </div>
            )}
          </Section>

          {/* App info section */}
          <Section title="About">
            <div className="flex flex-col gap-1.5">
              <InfoRow label="App" value="Robots in a House" />
              {appVersion && <InfoRow label="Version" value={`v${appVersion}`} />}
              {dataDir && (
                <InfoRow label="Data" value={dataDir} mono truncate />
              )}
              <InfoRow
                label="Source"
                value="github.com/ParadiseMG"
                href="https://github.com/ParadiseMG/robots-in-a-house-desktop"
              />
            </div>
          </Section>

          {/* Keyboard shortcuts */}
          <Section title="Keyboard shortcuts">
            <div className="flex flex-col gap-1.5">
              <ShortcutRow keys={["1", "2", "3"]} label="Switch office" />
              <ShortcutRow keys={["G"]} label="Toggle grid overlay" />
              <ShortcutRow keys={["Cmd", "K"]} label="Command palette" />
              <ShortcutRow keys={["Shift", "Click"]} label="Quick-cast prompt" />
              <ShortcutRow keys={["Esc"]} label="Close panel" />
            </div>
          </Section>
        </div>
      </div>
    </>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-white/5 bg-white/[0.02] p-3">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-white/30">
        {title}
      </div>
      {children}
    </div>
  );
}

function InfoRow({
  label,
  value,
  href,
  mono,
  truncate,
}: {
  label: string;
  value: string;
  href?: string;
  mono?: boolean;
  truncate?: boolean;
}) {
  const valClass = `text-xs ${mono ? "font-mono" : ""} ${truncate ? "truncate max-w-[180px]" : ""}`;
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="font-mono text-xs text-white/40">{label}</span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={`${valClass} text-cyan-400 hover:underline`}
          title={value}
        >
          {value}
        </a>
      ) : (
        <span className={`${valClass} text-white/70`} title={value}>
          {value}
        </span>
      )}
    </div>
  );
}

function ShortcutRow({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-white/40">{label}</span>
      <div className="flex items-center gap-0.5">
        {keys.map((k, i) => (
          <kbd
            key={i}
            className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-white/60"
          >
            {k}
          </kbd>
        ))}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="h-3 w-3 animate-spin"
      viewBox="0 0 12 12"
      fill="none"
    >
      <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path
        d="M6 1a5 5 0 014.33 2.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
