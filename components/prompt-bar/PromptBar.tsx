"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { AgentConfig } from "@/lib/office-types";

export type PromptBarAgent = AgentConfig & { officeSlug: string };

type Props = {
  agents: PromptBarAgent[];
  onSent: (result: {
    deskId: string;
    runId: string | null;
    isReal: boolean;
  }) => void;
};

type MentionState = {
  open: boolean;
  query: string;
  anchor: number; // index of the '@' in text
  highlight: number;
};

export default function PromptBar({ agents, onSent }: Props) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [mention, setMention] = useState<MentionState>({
    open: false,
    query: "",
    anchor: -1,
    highlight: 0,
  });
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  const matches = useMemo(() => {
    if (!mention.open) return [];
    const q = mention.query.toLowerCase();
    return agents.filter(
      (a) => a.name.toLowerCase().startsWith(q) || a.id.toLowerCase().startsWith(q),
    );
  // Depend on the scalar fields only — not the whole object — so a highlight
  // or anchor change doesn't produce a new array reference and retrigger effects.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mention.open, mention.query, agents]);

  // Detect mention state on text/cursor change
  const refreshMention = useCallback(
    (value: string, caret: number) => {
      const upto = value.slice(0, caret);
      const at = upto.lastIndexOf("@");
      if (at < 0) {
        setMention((m) => (m.open ? { ...m, open: false } : m));
        return;
      }
      const between = upto.slice(at + 1);
      if (/\s/.test(between)) {
        setMention((m) => (m.open ? { ...m, open: false } : m));
        return;
      }
      // must be start-of-line or preceded by whitespace
      if (at > 0 && !/\s/.test(value[at - 1])) {
        setMention((m) => (m.open ? { ...m, open: false } : m));
        return;
      }
      setMention({ open: true, query: between, anchor: at, highlight: 0 });
    },
    [],
  );

  useEffect(() => {
    // Clamp highlight when the match list shrinks (e.g. user keeps typing).
    // Skip when matches is empty — highlight will reset to 0 when mention opens.
    if (mention.open && matches.length > 0 && mention.highlight >= matches.length) {
      setMention((m) => ({ ...m, highlight: matches.length - 1 }));
    }
  // Use matches.length (not the array ref) so a new-but-same-length array
  // doesn't re-fire this effect and cause an infinite setState loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches.length, mention.open, mention.highlight]);

  const pickAgent = (agent: AgentConfig) => {
    if (!areaRef.current) return;
    const caret = areaRef.current.selectionStart ?? text.length;
    const before = text.slice(0, mention.anchor);
    const after = text.slice(caret);
    const inserted = `@${agent.name} `;
    const next = before + inserted + after;
    const nextCaret = (before + inserted).length;
    setText(next);
    setMention({ open: false, query: "", anchor: -1, highlight: 0 });
    requestAnimationFrame(() => {
      if (areaRef.current) {
        areaRef.current.focus();
        areaRef.current.setSelectionRange(nextCaret, nextCaret);
      }
    });
  };

  const parseMentioned = (value: string) => {
    // Find first @Name token and resolve to agentId
    const m = value.match(/(^|\s)@([A-Za-z0-9_-]+)/);
    if (!m) return null;
    const token = m[2].toLowerCase();
    const agent = agents.find(
      (a) => a.name.toLowerCase() === token || a.id.toLowerCase() === token,
    );
    if (!agent) return null;
    const stripped = value.replace(m[0], m[1]).trim();
    return { agent, prompt: stripped };
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention.open && matches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMention((m) => ({ ...m, highlight: (m.highlight + 1) % matches.length }));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMention((m) => ({
          ...m,
          highlight: (m.highlight - 1 + matches.length) % matches.length,
        }));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickAgent(matches[mention.highlight]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention((m) => ({ ...m, open: false }));
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const send = async () => {
    setError(null);
    const parsed = parseMentioned(text);
    if (!parsed) {
      setError("Pick an agent with @name");
      return;
    }
    if (!parsed.prompt) {
      setError("Add a message");
      return;
    }
    setSending(true);
    try {
      const res = await fetch("/api/quick-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          officeSlug: parsed.agent.officeSlug,
          agentId: parsed.agent.id,
          prompt: parsed.prompt,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const j = (await res.json()) as {
        queued?: boolean;
        deskId: string;
        runId: string | null;
        isReal: boolean;
      };
      setText("");
      if (j.queued) {
        setToast(`queued for ${parsed.agent.name}`);
        setTimeout(() => setToast(null), 2500);
      }
      onSent(j);
    } catch (err) {
      setError(err instanceof Error ? err.message : "send failed");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="relative border-t border-white/10 bg-zinc-950 px-3 py-2">
      {mention.open && matches.length > 0 && (
        <div className="absolute bottom-full left-3 mb-1 w-64 overflow-hidden rounded-md border border-white/15 bg-zinc-900 shadow-xl">
          {matches.map((a, i) => (
            <button
              key={a.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                pickAgent(a);
              }}
              className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm ${
                i === mention.highlight
                  ? "bg-white/10 text-white"
                  : "text-white/80 hover:bg-white/5"
              }`}
            >
              <span className="min-w-0 truncate">
                <span className="font-medium">@{a.name}</span>
                <span className="ml-1.5 text-[10px] text-white/30">{a.officeSlug}</span>
                <span className="ml-1.5 text-xs text-white/50">{a.role}</span>
              </span>
              {a.isReal ? (
                <span className="rounded bg-emerald-400/20 px-1 py-0.5 font-mono text-[9px] uppercase tracking-wider text-emerald-300">
                  real
                </span>
              ) : (
                <span className="rounded bg-white/10 px-1 py-0.5 font-mono text-[9px] uppercase tracking-wider text-white/50">
                  sim
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/20 text-white/50">
          <svg
            viewBox="0 0 24 24"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M21 12a9 9 0 1 1-3.2-6.9L21 3v6h-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <textarea
          ref={areaRef}
          rows={1}
          value={text}
          placeholder="@melody run a quick update on the new event…"
          onChange={(e) => {
            const v = e.target.value;
            setText(v);
            refreshMention(v, e.target.selectionStart ?? v.length);
          }}
          onKeyDown={onKey}
          onSelect={(e) =>
            refreshMention(text, (e.target as HTMLTextAreaElement).selectionStart ?? 0)
          }
          disabled={sending}
          className="flex-1 resize-none rounded-md border border-white/15 bg-black/50 px-3 py-2 font-mono text-sm text-white placeholder:text-white/30 focus:border-white/30 focus:outline-none disabled:opacity-50"
          style={{ maxHeight: 160 }}
        />
        <button
          type="button"
          onClick={send}
          disabled={sending || !text.trim()}
          className="h-8 shrink-0 rounded-md border border-white/20 bg-white/10 px-3 font-mono text-xs uppercase tracking-wider text-white hover:bg-white/20 disabled:opacity-40"
        >
          {sending ? "…" : "send"}
        </button>
      </div>
      {error && (
        <div className="mt-1 font-mono text-[10px] text-red-400">{error}</div>
      )}
      {toast && (
        <div className="mt-1 font-mono text-[10px] text-amber-300/80">{toast}</div>
      )}
    </div>
  );
}
