"use client";

import { useEffect, useState } from "react";

export type AmbientLine = {
  agentId: string;
  deskId: string;
  lastLine: string;
  ts: number;
  status: "thinking" | "text";
};

type StreamEvent =
  | { kind: "assistant"; payload: { text: string } }
  | { kind: "status"; payload: { status: string } }
  | { kind: "close" };

type ActiveRun = {
  agentId: string;
  deskId: string;
  runId: string;
};

/** Friendly label for common tool-call patterns in assistant text. */
function friendlyLine(raw: string): string {
  const t = raw.toLowerCase();
  if (/\bread\b|reading/.test(t)) return "reading files...";
  if (/\bedit\b|editing/.test(t)) return "editing code...";
  if (/\bgrep\b|searching/.test(t)) return "searching...";
  if (/\bbash\b|running/.test(t)) return "running command...";
  const trimmed = raw.length > 80 ? raw.slice(0, 80) + "…" : raw;
  return trimmed;
}

/**
 * Subscribes to SSE streams for all active runs (not the focused tab).
 * Emits the last line of assistant text per agent for ambient bubble display.
 * Also emits a "thinking" placeholder for busy agents with no text yet.
 */
export function useAmbientStream(
  activeRuns: ActiveRun[],
  focusedAgentId: string | null,
  busyAgentIds: ReadonlySet<string> = new Set(),
): Map<string, AmbientLine> {
  const [lines, setLines] = useState<Map<string, AmbientLine>>(new Map());

  // Inject thinking placeholders for busy agents that have no text yet
  useEffect(() => {
    const nonFocusedBusy = activeRuns.filter(
      (r) => r.agentId !== focusedAgentId && busyAgentIds.has(r.agentId),
    );
    if (nonFocusedBusy.length === 0) return;
    setLines((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const r of nonFocusedBusy) {
        if (!next.has(r.agentId)) {
          next.set(r.agentId, {
            agentId: r.agentId,
            deskId: r.deskId,
            lastLine: "...",
            ts: Date.now(),
            status: "thinking",
          });
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [
    activeRuns.map((r) => `${r.runId}:${r.agentId}`).sort().join(","),
    focusedAgentId,
    [...busyAgentIds].sort().join(","),
  ]);

  useEffect(() => {
    // Only stream for non-focused agents
    const targets = activeRuns.filter((r) => r.agentId !== focusedAgentId);
    if (targets.length === 0) return;

    const sources: EventSource[] = [];

    for (const target of targets) {
      const es = new EventSource(`/api/runs/${encodeURIComponent(target.runId)}/stream`);
      sources.push(es);

      es.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as StreamEvent;
          if (msg.kind === "assistant" && msg.payload.text) {
            const text = msg.payload.text;
            // Take the last non-empty line
            const rawLine = text
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean)
              .pop() ?? text.slice(-120);
            const lastLine = friendlyLine(rawLine);
            setLines((prev) => {
              const next = new Map(prev);
              next.set(target.agentId, {
                agentId: target.agentId,
                deskId: target.deskId,
                lastLine,
                ts: Date.now(),
                status: "text",
              });
              return next;
            });
          } else if (msg.kind === "status") {
            const s = msg.payload.status;
            if (s === "done" || s === "error") {
              es.close();
              // Clear the line after a delay
              setTimeout(() => {
                setLines((prev) => {
                  const next = new Map(prev);
                  next.delete(target.agentId);
                  return next;
                });
              }, 3000);
            }
          } else if (msg.kind === "close") {
            es.close();
          }
        } catch {
          // ignore
        }
      };
    }

    return () => {
      for (const es of sources) es.close();
    };
  }, [
    // Stringify to avoid re-running on every render (Map/array identity changes)
    activeRuns.map((r) => `${r.runId}:${r.agentId}`).sort().join(","),
    focusedAgentId,
  ]);

  return lines;
}
