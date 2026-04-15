"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

type BaseProps = {
  x: number;
  y: number;
  containerRef: RefObject<HTMLDivElement | null>;
  onDismiss: () => void;
};

type InteractiveProps = BaseProps & {
  mode: "task" | "reply";
  onSubmit: (text: string) => void | Promise<void>;
  text?: never;
};

type AmbientProps = BaseProps & {
  mode: "ambient";
  /** The text snippet to display (read-only, auto-fades) */
  text: string;
  onSubmit?: never;
};

type Props = InteractiveProps | AmbientProps;

export default function SpriteBubble({
  x,
  y,
  mode,
  containerRef,
  onSubmit,
  onDismiss,
  text: ambientText,
}: Props) {
  const [inputText, setInputText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [visible, setVisible] = useState(true);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Position bubble relative to container
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    setPos({ left: x - rect.left, top: y - rect.top });
  }, [x, y, containerRef]);

  // Focus input for interactive modes
  useEffect(() => {
    if (mode !== "ambient") inputRef.current?.focus();
  }, [mode]);

  // Ambient: auto-fade after 3s
  useEffect(() => {
    if (mode !== "ambient") return;
    const t = window.setTimeout(() => {
      setVisible(false);
      window.setTimeout(() => onDismiss(), 400); // allow CSS fade
    }, 3000);
    return () => window.clearTimeout(t);
  }, [mode, onDismiss]);

  // Escape + click-outside for interactive modes
  useEffect(() => {
    if (mode === "ambient") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (bubbleRef.current && !bubbleRef.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    window.addEventListener("keydown", onKey);
    const t = window.setTimeout(() => {
      window.addEventListener("mousedown", onClick);
    }, 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onClick);
    };
  }, [mode, onDismiss]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = inputText.trim();
    if (!trimmed || submitting || !onSubmit) return;
    setSubmitting(true);
    try {
      await onSubmit(trimmed);
    } finally {
      setSubmitting(false);
    }
  };

  if (!pos) return null;

  const style = {
    left: pos.left,
    top: pos.top,
    transform: "translate(-50%, -100%)",
  };

  // Ambient mode: read-only pill
  if (mode === "ambient") {
    return (
      <div
        ref={bubbleRef}
        className="absolute z-40 pointer-events-none transition-opacity duration-400"
        style={{ ...style, opacity: visible ? 1 : 0 }}
      >
        <div className="max-w-[200px] rounded-md border border-white/15 bg-black/80 px-2 py-1 font-mono text-[10px] text-white/70 shadow-lg backdrop-blur-sm">
          {ambientText}
        </div>
        <div
          className="mx-auto h-0 w-0"
          style={{
            borderLeft: "5px solid transparent",
            borderRight: "5px solid transparent",
            borderTop: "5px solid rgba(0,0,0,0.8)",
          }}
        />
      </div>
    );
  }

  // Interactive modes (task / reply)
  const placeholder = mode === "task" ? "give a task…" : "reply…";
  const label = mode === "task" ? "send" : "reply";

  return (
    <div
      ref={bubbleRef}
      className="absolute z-50"
      style={style}
    >
      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-1 rounded-md border border-white/20 bg-black/90 px-2 py-1.5 font-mono text-xs text-white shadow-lg backdrop-blur-sm"
      >
        <input
          ref={inputRef}
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder={placeholder}
          disabled={submitting}
          className="w-48 bg-transparent outline-none placeholder:text-white/40 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={submitting || !inputText.trim()}
          className="rounded border border-white/20 px-2 py-0.5 text-[10px] uppercase tracking-wide hover:bg-white/10 disabled:opacity-40"
        >
          {submitting ? "…" : label}
        </button>
      </form>
      <div
        className="mx-auto h-0 w-0"
        style={{
          borderLeft: "6px solid transparent",
          borderRight: "6px solid transparent",
          borderTop: "6px solid rgba(0, 0, 0, 0.9)",
        }}
      />
    </div>
  );
}
