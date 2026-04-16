"use client";

import { useEffect, useState } from "react";

type Usage = {
  windowMs: number;
  since: number;
  until: number;
  runs: number;
  tokens: number;
  limit: number;
  pct: number;
};

const POLL_MS = 30_000;

const fmtTokens = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
};

export default function UsageTracker() {
  const [usage, setUsage] = useState<Usage | null>(null);

  useEffect(() => {
    let alive = true;
    const fetchIt = async () => {
      try {
        const res = await fetch("/api/usage", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as Usage;
        if (alive) setUsage(json);
      } catch {
        // ignore
      }
    };
    fetchIt();
    const id = setInterval(fetchIt, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!usage) return null;

  const tone =
    usage.pct >= 0.9
      ? { bar: "bg-red-400", text: "text-red-300" }
      : usage.pct >= 0.75
        ? { bar: "bg-amber-400", text: "text-amber-300" }
        : usage.pct >= 0.5
          ? { bar: "bg-emerald-400", text: "text-emerald-300" }
          : { bar: "bg-emerald-400/70", text: "text-emerald-300/80" };

  return (
    <div className="border-t border-white/10 bg-zinc-950/60 px-4 py-1.5 font-mono text-[10px] text-white/60">
      <div className="flex items-center justify-between">
        <span className="uppercase tracking-wider text-white/40">
          5h tokens (i/o)
        </span>
        <span className={tone.text}>
          {fmtTokens(usage.tokens)} / {fmtTokens(usage.limit)} ·{" "}
          {Math.round(usage.pct * 100)}% · {usage.runs} run
          {usage.runs === 1 ? "" : "s"}
        </span>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded bg-white/10">
        <div
          className={`h-full ${tone.bar} transition-all`}
          style={{ width: `${Math.max(2, usage.pct * 100)}%` }}
        />
      </div>
    </div>
  );
}
