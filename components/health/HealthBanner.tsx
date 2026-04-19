"use client";

import { useEffect, useState } from "react";

type Check = {
  id: string;
  label: string;
  status: "ok" | "warn" | "error";
  detail: string;
};

type HealthData = {
  status: "ok" | "warn" | "error";
  checks: Check[];
};

const STATUS_ICON: Record<string, string> = {
  ok: "\u2713",
  warn: "!",
  error: "\u2717",
};

const STATUS_COLOR: Record<string, string> = {
  ok: "text-green-400",
  warn: "text-yellow-400",
  error: "text-red-400",
};

const BORDER_COLOR: Record<string, string> = {
  warn: "border-yellow-400/30 bg-yellow-400/5",
  error: "border-red-400/30 bg-red-400/5",
};

export default function HealthBanner() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    // Check if already dismissed this session
    if (sessionStorage.getItem("ri-health-dismissed")) {
      setDismissed(true);
      return;
    }

    fetch("/api/health")
      .then((r) => r.json())
      .then((data: HealthData) => setHealth(data))
      .catch(() => {});
  }, []);

  if (dismissed || !health || health.status === "ok") return null;

  const problems = health.checks.filter((c) => c.status !== "ok");
  const hasError = health.checks.some((c) => c.status === "error");

  return (
    <div
      className={`mx-4 mt-2 rounded-lg border px-4 py-2.5 font-mono text-xs ${
        BORDER_COLOR[health.status]
      }`}
    >
      <div className="flex items-center justify-between">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 text-left"
        >
          <span className={hasError ? "text-red-400" : "text-yellow-400"}>
            {hasError ? "\u2717" : "!"}
          </span>
          <span className="text-white/70">
            {hasError
              ? `${problems.length} issue${problems.length !== 1 ? "s" : ""} found — agents may not work`
              : `${problems.length} warning${problems.length !== 1 ? "s" : ""}`}
          </span>
          <span className="text-white/20">{expanded ? "▾" : "▸"}</span>
        </button>
        <button
          onClick={() => {
            setDismissed(true);
            sessionStorage.setItem("ri-health-dismissed", "1");
          }}
          className="text-white/20 hover:text-white/50 transition-colors px-1"
        >
          dismiss
        </button>
      </div>

      {expanded && (
        <div className="mt-3 flex flex-col gap-2 border-t border-white/5 pt-3">
          {health.checks.map((check) => (
            <div key={check.id} className="flex items-start gap-2">
              <span className={`${STATUS_COLOR[check.status]} w-3 text-center flex-shrink-0`}>
                {STATUS_ICON[check.status]}
              </span>
              <div className="flex-1 min-w-0">
                <span className="text-white/60 font-bold">{check.label}</span>
                <span className="text-white/30 ml-2">{check.detail}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
