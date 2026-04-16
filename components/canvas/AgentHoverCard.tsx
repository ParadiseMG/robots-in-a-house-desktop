"use client";

import { useEffect, useRef, useState } from "react";
import { isContextWarning, modelMaxTokens } from "@/lib/model-context";

type AgentInfo = {
  deskId: string;
  officeSlug: string;
  name: string;
  role: string;
  isReal: boolean;
  model: string | null;
};

type RunInfo = {
  runStatus: string | null;
  task: { title: string } | null;
  tokens: number | null;
};

type Props = {
  agent: AgentInfo;
  run?: RunInfo | null;
  queueDepth?: number;
  /** Client-space position of the sprite centre */
  anchorX: number;
  anchorY: number;
  onDismiss: () => void;
};

const modelLabel = (m: string | null) => {
  const s = (m ?? "").toLowerCase();
  if (s.includes("opus")) return "opus";
  if (s.includes("haiku")) return "haiku";
  if (s.includes("sonnet")) return "sonnet";
  return m ?? "sonnet";
};

const statusColor = (s: string | null) => {
  if (!s) return "text-white/40";
  if (s === "running" || s === "starting") return "text-amber-300";
  if (s === "done") return "text-emerald-300";
  if (s === "awaiting_input") return "text-yellow-200";
  if (s === "error") return "text-red-300";
  return "text-white/40";
};

export default function AgentHoverCard({ agent, run, queueDepth, anchorX, anchorY, onDismiss }: Props) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const W = card.offsetWidth || 200;
    const H = card.offsetHeight || 100;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = anchorX - W / 2;
    let top = anchorY - H - 12;
    if (left + W > vw - 8) left = vw - W - 8;
    if (left < 8) left = 8;
    if (top < 8) top = anchorY + 12;
    setPos({ left, top });
  }, [anchorX, anchorY]);

  // Dismiss on escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [onDismiss]);

  const tokens = run?.tokens ?? 0;
  const maxTok = modelMaxTokens(agent.model);
  const ctxPct = tokens > 0 ? Math.round((tokens / maxTok) * 100) : null;
  const ctxWarn = tokens > 0 && isContextWarning(agent.model, tokens);

  const mlabel = modelLabel(agent.model);
  const isOpus = mlabel === "opus";

  return (
    <div
      ref={cardRef}
      className="fixed z-50 w-52 rounded border border-white/20 bg-zinc-900/95 p-2.5 shadow-2xl backdrop-blur-sm pointer-events-none"
      style={pos ? { left: pos.left, top: pos.top } : { left: anchorX, top: anchorY, opacity: 0 }}
    >
      {/* Agent identity */}
      <div className="mb-2">
        <div className="text-sm font-medium text-white">{agent.name}</div>
        <div className="text-[11px] text-white/50">{agent.role}</div>
      </div>

      {/* Badges */}
      <div className="mb-2 flex flex-wrap gap-1 font-mono text-[9px] uppercase tracking-wider">
        <span className={agent.isReal ? "rounded bg-emerald-400/20 px-1.5 py-0.5 text-emerald-300" : "rounded bg-white/10 px-1.5 py-0.5 text-white/50"}>
          {agent.isReal ? "real" : "sim"}
        </span>
        {agent.isReal && (
          <span className={isOpus ? "rounded bg-purple-400/20 px-1.5 py-0.5 text-purple-300" : "rounded bg-sky-400/15 px-1.5 py-0.5 text-sky-300"}>
            {mlabel}
          </span>
        )}
        {run?.runStatus && (
          <span className={`rounded bg-white/5 px-1.5 py-0.5 ${statusColor(run.runStatus)}`}>
            {run.runStatus}
          </span>
        )}
      </div>

      {/* Current task */}
      {run?.task && (
        <div className="mb-2">
          <div className="font-mono text-[9px] uppercase tracking-wider text-white/30">task</div>
          <div className="truncate text-[11px] text-white/80">{run.task.title}</div>
        </div>
      )}

      {/* Context meter */}
      {agent.isReal && ctxPct !== null && (
        <div>
          <div className="mb-0.5 flex items-center justify-between font-mono text-[9px]">
            <span className="uppercase tracking-wider text-white/30">ctx</span>
            <span className={ctxWarn ? "text-amber-300" : "text-white/50"}>
              {ctxPct}%{ctxWarn && " ⚠"}
            </span>
          </div>
          <div className="h-1 w-full overflow-hidden rounded bg-white/10">
            <div
              className={`h-full transition-all ${ctxWarn ? "bg-amber-400" : "bg-emerald-400"}`}
              style={{ width: `${Math.max(2, ctxPct)}%` }}
            />
          </div>
        </div>
      )}

      {/* Queue depth */}
      {queueDepth != null && queueDepth > 0 && (
        <div className="mt-1.5 font-mono text-[9px] text-amber-300/70">
          {queueDepth} queued
        </div>
      )}

      {/* Cost — not available from current API */}
      <div className="mt-1.5 font-mono text-[9px] text-white/20">
        cost —
      </div>
    </div>
  );
}
