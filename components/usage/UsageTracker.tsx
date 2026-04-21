"use client";

import { useState } from "react";
import { useVisibleInterval } from "@/hooks/useVisibleInterval";

type RateLimitWindow = {
  utilization: number;
  resetsAt: number | null;
  status: string;
  updatedAt: number;
};

type Usage = {
  runs: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  fiveHour: RateLimitWindow | null;
  sevenDay: RateLimitWindow | null;
};

const POLL_MS = 15_000;

const fmtTokens = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
};

const fmtTimeLeft = (resetsAt: number | null) => {
  if (!resetsAt) return null;
  const ms = resetsAt * 1000 - Date.now();
  if (ms <= 0) return "resetting";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

const toneFor = (pct: number) =>
  pct >= 0.9
    ? { bar: "bg-red-400", text: "text-red-300" }
    : pct >= 0.75
      ? { bar: "bg-amber-400", text: "text-amber-300" }
      : pct >= 0.5
        ? { bar: "bg-emerald-400", text: "text-emerald-300" }
        : { bar: "bg-emerald-400/70", text: "text-emerald-300/80" };

function UsageBar({
  label,
  pct,
  detail,
}: {
  label: string;
  pct: number;
  detail: string;
}) {
  const tone = toneFor(pct);
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="uppercase tracking-wider text-white/40">{label}</span>
        <span className={tone.text}>{detail}</span>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded bg-white/10">
        <div
          className={`h-full ${tone.bar} transition-all`}
          style={{ width: `${Math.max(2, pct * 100)}%` }}
        />
      </div>
    </div>
  );
}

export default function UsageTracker() {
  const [usage, setUsage] = useState<Usage | null>(null);

  useVisibleInterval(() => {
    fetch("/api/usage", { cache: "no-store" })
      .then((r) => r.ok ? r.json() as Promise<Usage> : null)
      .then((json) => { if (json) setUsage(json); })
      .catch(() => {});
  }, POLL_MS);

  if (!usage) return null;

  // Only show when utilization is high enough to be a warning
  if (!usage.fiveHour || usage.fiveHour.utilization < 0.75) return null;

  return (
    <div className="border-t border-white/10 bg-zinc-950/60 px-4 py-1.5 font-mono text-[10px] text-white/60 space-y-1.5">
      <UsageBar
        label="5h window"
        pct={usage.fiveHour.utilization}
        detail={`${Math.round(usage.fiveHour.utilization * 100)}% · ${fmtTimeLeft(usage.fiveHour.resetsAt) ?? "—"} left · ${usage.runs} run${usage.runs === 1 ? "" : "s"}`}
      />
      {usage.sevenDay && (
        <UsageBar
          label="7d window"
          pct={usage.sevenDay.utilization}
          detail={`${Math.round(usage.sevenDay.utilization * 100)}% · ${fmtTimeLeft(usage.sevenDay.resetsAt) ?? "—"} left`}
        />
      )}
    </div>
  );
}
