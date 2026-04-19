"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ToolCallLine from "@/components/dock/ToolCallLine";
import Tooltip from "@/components/ui/Tooltip";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // fallback
    }
  };

  return (
    <div className="absolute right-1.5 top-1.5">
      <Tooltip label={copied ? "Copied!" : "Copy message"}>
        <button
          onClick={handleCopy}
          className="rounded p-0.5 text-white/0 transition-colors group-hover:text-white/40 hover:!text-white/70 hover:!bg-white/10"
        >
          {copied ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
      </Tooltip>
    </div>
  );
}

export type ChatMessage = {
  role: "user" | "assistant";
  ts: number;
  text: string;
  runId?: string;
};

export type PendingMessage = {
  id: string;
  text: string;
  queuedAt: number;
};

type LiveTool = { name: string; id: string };

type Props = {
  messages: ChatMessage[] | null;
  pendingMessages: PendingMessage[];
  liveText: string;
  liveTools: LiveTool[];
  liveStatus: string | null;
  isLive: boolean;
};

const fmt = (ts: number) => {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export default function MessageList({
  messages,
  pendingMessages,
  liveText,
  liveTools,
  liveStatus,
  isLive,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Track whether the user has scrolled away from the bottom.
  // Only USER-initiated scrolls set this — programmatic scrolls are ignored
  // via the `programmaticScroll` guard.
  const userScrolledRef = useRef(false);
  const prevMessageCountRef = useRef(0);
  const prevLiveTextLenRef = useRef(0);
  const programmaticScrollRef = useRef(false);

  const onScroll = useCallback(() => {
    // Ignore scroll events caused by our own scrollTop assignment
    if (programmaticScrollRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledRef.current = distFromBottom > 80;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    programmaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    // Reset the guard after the browser fires the scroll event
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, []);

  // Scroll on new messages or pending messages being added
  useEffect(() => {
    const currentCount = (messages?.length ?? 0) + pendingMessages.length;
    const newContent = currentCount > prevMessageCountRef.current;
    prevMessageCountRef.current = currentCount;

    if (!userScrolledRef.current || newContent) {
      scrollToBottom();
    }
  }, [messages, pendingMessages, scrollToBottom]);

  // Scroll on live text only if user is at the bottom
  useEffect(() => {
    const len = liveText.length;
    const grew = len > prevLiveTextLenRef.current;
    prevLiveTextLenRef.current = len;

    if (grew && !userScrolledRef.current) {
      scrollToBottom();
    }
  }, [liveText, scrollToBottom]);

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="flex-1 overflow-y-auto space-y-2 p-2"
    >
      {messages === null ? (
        <div className="text-center text-xs text-white/30 pt-8">loading…</div>
      ) : messages.length === 0 && !isLive ? (
        <div className="text-center text-xs text-white/30 pt-8">
          no messages yet
        </div>
      ) : (
        <>
          {messages.map((m, i) => (
            <div
              key={i}
              className={`group relative ${
                m.role === "user"
                  ? "ml-8 rounded-lg rounded-tr-sm bg-sky-400/15 p-2 text-xs text-sky-100"
                  : "mr-8 rounded-lg rounded-tl-sm bg-white/10 p-2 text-xs text-white/90"
              }`}
            >
              <CopyButton text={m.text} />
              <div className="whitespace-pre-wrap font-mono leading-relaxed">
                {m.text}
              </div>
              <div className="mt-0.5 text-right font-mono text-[9px] text-white/30">
                {fmt(m.ts)}
              </div>
            </div>
          ))}

          {/* Pending messages */}
          {pendingMessages.map((p, i) => (
            <div
              key={`pending-${p.id}`}
              className="ml-8 rounded-lg rounded-tr-sm border border-amber-400/30 bg-amber-400/10 p-2 text-xs text-amber-100"
            >
              <div className="whitespace-pre-wrap font-mono leading-relaxed">
                {p.text}
              </div>
              <div className="mt-0.5 flex items-center justify-between font-mono text-[9px]">
                <span className="text-amber-300/60">
                  {i === 0 ? "next in queue" : `${i + 1} in queue`}
                </span>
                <span className="text-amber-300/40">
                  {fmt(p.queuedAt)}
                </span>
              </div>
            </div>
          ))}

          {/* Live tool calls */}
          {isLive && liveTools.length > 0 && (
            <div className="space-y-0.5 px-1">
              {liveTools.map((t) => (
                <ToolCallLine key={t.id} name={t.name} />
              ))}
            </div>
          )}

          {/* Live assistant text */}
          {isLive && liveText && (
            <div className="mr-8 rounded-lg rounded-tl-sm border border-amber-400/30 bg-amber-400/5 p-2 text-xs text-white/90">
              <div className="whitespace-pre-wrap font-mono leading-relaxed">
                {liveText}
              </div>
              <div className="mt-0.5 font-mono text-[9px] text-amber-300/60">
                typing…
              </div>
            </div>
          )}

          {/* Starting / thinking state */}
          {isLive && !liveText && (
            <div className="mr-8 rounded-lg rounded-tl-sm bg-white/5 p-2 text-xs text-white/40">
              <span className="font-mono">
                {liveStatus === "starting" || !liveStatus
                  ? "starting…"
                  : "thinking…"}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
