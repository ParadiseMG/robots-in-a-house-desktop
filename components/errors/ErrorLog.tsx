"use client";

import { useRef, useState } from "react";
import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import Tooltip from "@/components/ui/Tooltip";

type ErrorEntry = {
  id: string;
  ts: number;
  source: "runner" | "api" | "agent" | "frontend";
  severity: "error" | "warn" | "fatal";
  message: string;
  stack: string | null;
  agent_id: string | null;
  office_slug: string | null;
  run_id: string | null;
  context: string | null;
  acknowledged_at: number | null;
};

const POLL_MS = 5000;
const ERROR_COLOR = "#f87171";
const WARN_COLOR = "#fbbf24";
const FATAL_COLOR = "#ef4444";

function sourceLabel(source: string): string {
  switch (source) {
    case "runner": return "RUN";
    case "api": return "API";
    case "agent": return "AGT";
    case "frontend": return "FE";
    default: return source.toUpperCase().slice(0, 3);
  }
}

function severityColor(severity: string): string {
  switch (severity) {
    case "fatal": return FATAL_COLOR;
    case "warn": return WARN_COLOR;
    default: return ERROR_COLOR;
  }
}

function timeLabel(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

type Props = {
  officeNames: ReadonlyMap<string, string>;
  onOpenAgent?: (officeSlug: string, agentId: string) => void;
  activeOfficeSlug?: string | null;
  activeAgentId?: string | null;
};

export default function ErrorLog({ officeNames, onOpenAgent, activeOfficeSlug, activeAgentId }: Props) {
  const [errors, setErrors] = useState<ErrorEntry[]>([]);
  const [count, setCount] = useState(0);
  const [collapsed, setCollapsed] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const prevCountRef = useRef(0);

  useVisibleInterval(() => {
    fetch("/api/errors?limit=30")
      .then((r) => r.ok ? r.json() as Promise<{ errors: ErrorEntry[]; unacknowledgedCount: number }> : null)
      .then((j) => {
        if (!j) return;
        setErrors(j.errors);
        setCount(j.unacknowledgedCount);
        if (j.unacknowledgedCount > prevCountRef.current && prevCountRef.current > 0) {
          setCollapsed(false);
        }
        prevCountRef.current = j.unacknowledgedCount;
      })
      .catch(() => {});
  }, POLL_MS);

  const dismiss = async (id: string) => {
    setErrors((prev) => prev.filter((e) => e.id !== id));
    setCount((c) => Math.max(0, c - 1));
    try {
      await fetch("/api/errors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "ack", id }),
      });
    } catch {
      // will reappear next poll
    }
  };

  const dismissAll = async () => {
    setErrors([]);
    setCount(0);
    try {
      await fetch("/api/errors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "ack_all" }),
      });
    } catch {
      // ignore
    }
  };

  const hasErrors = count > 0 || errors.length > 0;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between px-2">
        {hasErrors ? (
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="font-mono text-[9px] uppercase tracking-widest hover:text-white/70"
            style={{ color: ERROR_COLOR }}
            title={collapsed ? "expand errors" : "collapse errors"}
          >
            {collapsed ? ">" : "v"} errors · {count}
          </button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          {!collapsed && count > 1 && (
            <button
              type="button"
              onClick={() => void dismissAll()}
              className="font-mono text-[9px] uppercase tracking-wider text-white/30 hover:text-white/60"
            >
              clear all
            </button>
          )}
        </div>
      </div>

      {!collapsed &&
        errors.map((err) => {
          const color = severityColor(err.severity);
          const officeName = err.office_slug
            ? officeNames.get(err.office_slug) ?? err.office_slug
            : null;
          const isExpanded = expandedId === err.id;

          return (
            <div
              key={err.id}
              className="group relative flex flex-col gap-0.5 rounded border px-2.5 py-2 transition hover:bg-white/[0.04]"
              style={{
                borderColor: color + "44",
                background: color + "08",
              }}
            >
              <button
                type="button"
                onClick={() => setExpandedId(isExpanded ? null : err.id)}
                className="flex flex-col gap-0.5 text-left"
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                  <span
                    className="font-mono text-[10px] uppercase tracking-wider"
                    style={{ color }}
                  >
                    {sourceLabel(err.source)}
                  </span>
                  {err.severity !== "error" && (
                    <span
                      className="font-mono text-[9px] uppercase"
                      style={{ color }}
                    >
                      {err.severity}
                    </span>
                  )}
                  {officeName && (
                    <span className="font-mono text-[9px] text-white/30">
                      · {officeName}
                    </span>
                  )}
                  {err.agent_id && (
                    <span className="font-mono text-[9px] text-white/30">
                      · {err.agent_id}
                    </span>
                  )}
                  <span className="ml-auto font-mono text-[9px] text-white/25">
                    {timeLabel(err.ts)}
                  </span>
                </div>
                <div className="text-[11px] leading-tight text-white/70 group-hover:text-white/90">
                  {err.message.length > 120
                    ? err.message.slice(0, 120) + "..."
                    : err.message}
                </div>
              </button>

              {isExpanded && (
                <div className="mt-1 flex flex-col gap-1 border-t border-white/5 pt-1">
                  <div className="font-mono text-[10px] text-white/50">
                    {err.message}
                  </div>
                  {err.stack && (
                    <pre className="max-h-24 overflow-auto whitespace-pre-wrap font-mono text-[9px] text-white/30">
                      {err.stack}
                    </pre>
                  )}
                  {err.context && (
                    <pre className="max-h-16 overflow-auto whitespace-pre-wrap font-mono text-[9px] text-white/30">
                      {err.context}
                    </pre>
                  )}
                  {err.run_id && (
                    <div className="font-mono text-[9px] text-white/25">
                      run: {err.run_id.slice(0, 8)}
                    </div>
                  )}
                  {err.agent_id && err.office_slug && onOpenAgent && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenAgent(err.office_slug!, err.agent_id!);
                      }}
                      className="self-start font-mono text-[9px] uppercase tracking-wider text-white/40 hover:text-white/70"
                    >
                      open agent chat
                    </button>
                  )}
                </div>
              )}

              <div className="absolute right-1 top-1 opacity-0 group-hover:opacity-100 transition">
                <Tooltip label="Dismiss">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void dismiss(err.id);
                    }}
                    className="rounded px-1 font-mono text-[10px] leading-none text-white/25 hover:text-white/80"
                  >
                    x
                  </button>
                </Tooltip>
              </div>
            </div>
          );
        })}
    </div>
  );
}
