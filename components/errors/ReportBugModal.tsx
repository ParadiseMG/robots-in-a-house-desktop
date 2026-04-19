"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Props = {
  open: boolean;
  onClose: () => void;
  /** Pre-populate from context */
  officeSlug?: string | null;
  agentId?: string | null;
};

const SEVERITIES = ["error", "warn", "fatal"] as const;

export default function ReportBugModal({
  open,
  onClose,
  officeSlug,
  agentId,
}: Props) {
  const [message, setMessage] = useState("");
  const [severity, setSeverity] = useState<(typeof SEVERITIES)[number]>("error");
  const [context, setContext] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<"ok" | "fail" | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus textarea on open
  useEffect(() => {
    if (open) {
      setMessage("");
      setContext("");
      setSeverity("error");
      setResult(null);
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const submit = useCallback(async () => {
    if (!message.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/errors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "report",
          source: "user",
          severity,
          message: message.trim(),
          context: context.trim() || null,
          officeSlug: officeSlug ?? null,
          agentId: agentId ?? null,
        }),
      });
      setResult(res.ok ? "ok" : "fail");
      if (res.ok) {
        setTimeout(() => onClose(), 1200);
      }
    } catch {
      setResult("fail");
    } finally {
      setSubmitting(false);
    }
  }, [message, severity, context, officeSlug, agentId, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-sm rounded-lg border border-white/10 bg-zinc-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <span className="font-mono text-xs uppercase tracking-wider text-white/70">
            report bug
          </span>
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-xs text-white/30 hover:text-white/70"
          >
            esc
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-col gap-3 p-4">
          {/* Message */}
          <div className="flex flex-col gap-1">
            <label className="font-mono text-[10px] uppercase tracking-wider text-white/40">
              what happened?
            </label>
            <textarea
              ref={textareaRef}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Describe the bug..."
              rows={3}
              className="resize-none rounded border border-white/10 bg-white/5 px-2.5 py-2 font-mono text-xs text-white/90 placeholder:text-white/20 focus:border-white/25 focus:outline-none"
            />
          </div>

          {/* Severity */}
          <div className="flex flex-col gap-1">
            <label className="font-mono text-[10px] uppercase tracking-wider text-white/40">
              severity
            </label>
            <div className="flex gap-1.5">
              {SEVERITIES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSeverity(s)}
                  className={`rounded border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition ${
                    severity === s
                      ? s === "fatal"
                        ? "border-red-500/50 bg-red-500/20 text-red-300"
                        : s === "warn"
                          ? "border-amber-400/50 bg-amber-400/20 text-amber-300"
                          : "border-red-400/50 bg-red-400/20 text-red-300"
                      : "border-white/10 bg-transparent text-white/30 hover:text-white/50"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Context */}
          <div className="flex flex-col gap-1">
            <label className="font-mono text-[10px] uppercase tracking-wider text-white/40">
              extra context <span className="text-white/20">(optional)</span>
            </label>
            <textarea
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="Steps to reproduce, what you expected..."
              rows={2}
              className="resize-none rounded border border-white/10 bg-white/5 px-2.5 py-2 font-mono text-xs text-white/90 placeholder:text-white/20 focus:border-white/25 focus:outline-none"
            />
          </div>

          {/* Auto-populated context chips */}
          {(officeSlug || agentId) && (
            <div className="flex flex-wrap gap-1.5">
              {officeSlug && (
                <span className="rounded border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-[9px] text-white/40">
                  office: {officeSlug}
                </span>
              )}
              {agentId && (
                <span className="rounded border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-[9px] text-white/40">
                  agent: {agentId}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-white/10 px-4 py-3">
          {result === "ok" && (
            <span className="font-mono text-[10px] text-green-400">
              submitted — squash is on it
            </span>
          )}
          {result === "fail" && (
            <span className="font-mono text-[10px] text-red-400">
              failed to submit
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-white/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-white/40 hover:text-white/60"
          >
            cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!message.trim() || submitting || result === "ok"}
            className="rounded border border-red-400/40 bg-red-400/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-red-300 transition hover:bg-red-400/25 disabled:opacity-30 disabled:hover:bg-red-400/15"
          >
            {submitting ? "sending..." : "report"}
          </button>
        </div>
      </div>
    </div>
  );
}
