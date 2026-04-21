"use client";

import { useEffect, useRef } from "react";

/**
 * Like setInterval, but pauses when the browser tab is hidden.
 * Runs `callback` immediately on mount, then every `ms` while visible.
 * When the tab becomes visible again, fires immediately to catch up.
 */
export function useVisibleInterval(callback: () => void, ms: number, deps: unknown[] = []) {
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (id) return;
      cbRef.current(); // fire immediately on resume
      id = setInterval(() => cbRef.current(), ms);
    };

    const stop = () => {
      if (id) {
        clearInterval(id);
        id = null;
      }
    };

    const onVisChange = () => {
      if (document.hidden) {
        stop();
      } else {
        start();
      }
    };

    document.addEventListener("visibilitychange", onVisChange);

    // Start if currently visible
    if (!document.hidden) {
      start();
    }

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, ...deps]);
}
