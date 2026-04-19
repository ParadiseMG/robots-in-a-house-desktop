"use client";

import { useState, useRef, useCallback, type ReactNode } from "react";

type Props = {
  label: string;
  delay?: number;
  position?: "top" | "bottom";
  children: ReactNode;
};

export default function Tooltip({
  label,
  delay = 150,
  position = "top",
  children,
}: Props) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(() => {
    timerRef.current = setTimeout(() => setVisible(true), delay);
  }, [delay]);

  const hide = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setVisible(false);
  }, []);

  return (
    <div className="relative inline-flex" onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {visible && (
        <div
          className={`pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded bg-zinc-800 px-2 py-1 font-mono text-[9px] text-white/80 shadow-lg border border-white/10 ${
            position === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5"
          }`}
        >
          {label}
        </div>
      )}
    </div>
  );
}
