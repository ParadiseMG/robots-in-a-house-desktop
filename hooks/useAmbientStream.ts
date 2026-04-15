"use client";

import { useEffect, useState } from "react";

export type AmbientLine = {
  agentId: string;
  deskId: string;
  lastLine: string;
  ts: number;
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

/**
 * Subscribes to SSE streams for all active runs (not the focused tab).
 * Emits the last line of assistant text per agent for ambient bubble display.
 */
export function useAmbientStream(
  activeRuns: ActiveRun[],
  focusedAgentId: string | null,
): Map<string, AmbientLine> {
  const [lines, setLines] = useState<Map<string, AmbientLine>>(new Map());

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
            const lastLine = text
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean)
              .pop() ?? text.slice(-120);
            setLines((prev) => {
              const next = new Map(prev);
              next.set(target.agentId, {
                agentId: target.agentId,
                deskId: target.deskId,
                lastLine: lastLine.length > 80 ? lastLine.slice(0, 80) + "…" : lastLine,
                ts: Date.now(),
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
