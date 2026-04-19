"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import MessageList, { type ChatMessage, type PendingMessage } from "@/components/dock/MessageList";
import ToolCallLine from "@/components/dock/ToolCallLine";
import AwaitingInputForm from "@/components/dock/AwaitingInputForm";

type StreamEvent =
  | { kind: "assistant"; payload: { text: string } }
  | { kind: "tool_use"; payload: { name: string; input: unknown; id: string } }
  | { kind: "status"; payload: { status: string; error?: string; result?: string } }
  | { kind: "close" };

type InspectionCurrent = {
  runId: string | null;
  runStatus: string | null;
  inputQuestion: string | null;
  acknowledgedAt: number | null;
};

type Inspection = {
  agent: {
    id: string;
    name: string;
    role: string;
    isReal: boolean;
    model: string | null;
  };
  current: InspectionCurrent | null;
};

type Props = {
  officeSlug: string;
  agentId: string;
  deskId: string;
  agentName: string;
  /** Called when run status changes (for badge updates) */
  onStatusChange?: (status: string | null) => void;
};

export default function ChatTab({
  officeSlug,
  agentId,
  deskId,
  agentName,
  onStatusChange,
}: Props) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);
  const [liveText, setLiveText] = useState("");
  const [liveTools, setLiveTools] = useState<Array<{ name: string; id: string }>>([]);
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [chatText, setChatText] = useState("");
  const [chatPending, setChatPending] = useState(false);
  const [refetchNonce, setRefetchNonce] = useState(0);
  const [attachments, setAttachments] = useState<Array<{ name: string; path: string; type: string }>>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [resetting, setResetting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const latestAgentId = useRef(agentId);
  latestAgentId.current = agentId;

  // Fetch inspection data (agent + current run)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(
          `/api/inspector?office=${encodeURIComponent(officeSlug)}&deskId=${encodeURIComponent(deskId)}`,
        );
        if (!res.ok) return;
        const json = (await res.json()) as Inspection;
        if (alive) setInspection(json);
      } catch {
        // ignore
      }
    })();
    return () => { alive = false; };
  }, [officeSlug, deskId, refetchNonce]);

  // Fetch transcript
  useEffect(() => {
    let alive = true;
    setMessages(null);
    (async () => {
      try {
        const qs = new URLSearchParams({ office: officeSlug, agentId });
        const res = await fetch(`/api/session/transcript?${qs}`, { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { messages: ChatMessage[] };
        if (alive) setMessages(json.messages);
      } catch {
        // ignore
      }
    })();
    return () => { alive = false; };
  }, [officeSlug, agentId, refetchNonce]);

  // Fetch pending messages
  useEffect(() => {
    const fetchPendingMessages = async () => {
      try {
        const qs = new URLSearchParams({ office: officeSlug, agentId });
        const res = await fetch(`/api/queue?${qs}`, { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { queuedPrompts: Array<{ id: string; prompt: string; queued_at: number }> };
        setPendingMessages(json.queuedPrompts.map(q => ({
          id: q.id,
          text: q.prompt,
          queuedAt: q.queued_at,
        })));
      } catch {
        // ignore
      }
    };

    fetchPendingMessages();

    // Poll for updates every 3 seconds
    const interval = setInterval(fetchPendingMessages, 3000);
    return () => clearInterval(interval);
  }, [officeSlug, agentId, refetchNonce]);

  // Auto-ack done runs
  useEffect(() => {
    const c = inspection?.current;
    if (!c) return;
    if (c.runStatus === "done" && c.runId && c.acknowledgedAt == null) {
      void fetch(`/api/runs/${encodeURIComponent(c.runId)}/ack`, { method: "POST" }).catch(() => {});
    }
  }, [inspection]);

  // SSE stream for active runs
  const runId = inspection?.current?.runId ?? null;
  const runStatus = inspection?.current?.runStatus ?? null;
  const isLive = runStatus === "starting" || runStatus === "running";

  useEffect(() => {
    onStatusChange?.(runStatus);
  }, [runStatus, onStatusChange]);

  useEffect(() => {
    if (!runId || !isLive) {
      setLiveText("");
      setLiveTools([]);
      setLiveStatus(null);
      return;
    }
    setLiveText("");
    setLiveTools([]);
    setLiveStatus(null);
    let sawLive = false;
    const es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`);
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as StreamEvent;
        if (msg.kind === "assistant") {
          setLiveText((prev) => prev ? prev + "\n\n" + msg.payload.text : msg.payload.text);
        } else if (msg.kind === "tool_use") {
          setLiveTools((prev) => [...prev, { name: msg.payload.name, id: msg.payload.id }]);
        } else if (msg.kind === "status") {
          setLiveStatus(msg.payload.status);
          if (msg.payload.status === "starting" || msg.payload.status === "running") {
            sawLive = true;
          }
          if (msg.payload.status === "done" || msg.payload.status === "error" || msg.payload.status === "interrupted") {
            es.close();
            if (sawLive) setRefetchNonce((n) => n + 1);
          }
        } else if (msg.kind === "close") {
          es.close();
        }
      } catch {
        // ignore
      }
    };
    return () => { es.close(); };
  }, [runId, isLive]);

  const uploadFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    try {
      const uploaded = await Promise.all(files.map(async (file) => {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        if (!res.ok) throw new Error(`Upload failed: ${file.name}`);
        return (await res.json()) as { name: string; path: string; type: string };
      }));
      setAttachments((prev) => [...prev, ...uploaded]);
    } catch (err) {
      console.error(err);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, []);

  const onFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    await uploadFiles(Array.from(e.target.files ?? []));
  }, [uploadFiles]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDragOver(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
  }, []);

  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) await uploadFiles(files);
  }, [uploadFiles]);

  const onChat = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = chatText.trim();
    const agent = inspection?.agent;
    if ((!trimmed && attachments.length === 0) || !agent || chatPending) return;
    setChatPending(true);
    try {
      // Build prompt: prepend file references before user text
      let prompt = trimmed;
      if (attachments.length > 0) {
        const fileBlock = attachments
          .map((a) => `[Attached file: ${a.name} — path: ${a.path}]`)
          .join("\n");
        prompt = fileBlock + (trimmed ? "\n\n" + trimmed : "");
      }
      await fetch("/api/quick-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ officeSlug, agentId, prompt }),
      });
      setChatText("");
      setAttachments([]);
      setRefetchNonce((n) => n + 1);
    } finally {
      setChatPending(false);
    }
  };

  const onNewChat = async () => {
    if (resetting || isLive) return;
    setResetting(true);
    try {
      const res = await fetch("/api/break", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ officeSlug, agentId }),
      });
      if (res.ok) {
        setMessages([]);
        setLiveText("");
        setLiveTools([]);
        setLiveStatus(null);
        setChatText("");
        setAttachments([]);
        // Give the break run a moment to start, then refetch
        setTimeout(() => setRefetchNonce((n) => n + 1), 1500);
      }
    } finally {
      setResetting(false);
    }
  };

  const isReal = inspection?.agent?.isReal ?? false;
  const awaitingInput = runStatus === "awaiting_input";
  const busy = chatPending || awaitingInput; // Removed isLive - can send messages while agent is working

  return (
    <div
      className={`relative flex min-h-0 flex-1 flex-col transition-colors ${dragOver ? "bg-sky-500/5" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Drop overlay */}
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded border-2 border-dashed border-sky-400/60 bg-sky-500/10">
          <span className="font-mono text-xs text-sky-300">drop to attach</span>
        </div>
      )}
      {/* New chat button — top right */}
      {isReal && (
        <button
          type="button"
          onClick={onNewChat}
          disabled={resetting || isLive}
          title="Start a new conversation (agent saves memory, then resets)"
          className="absolute right-2 top-2 z-20 rounded border border-white/15 bg-black/70 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-white/40 backdrop-blur transition hover:border-white/30 hover:text-white/70 disabled:opacity-30"
        >
          {resetting ? "resetting…" : "new chat"}
        </button>
      )}

      {/* Message area */}
      <MessageList
        messages={messages}
        pendingMessages={pendingMessages}
        liveText={liveText}
        liveTools={liveTools}
        liveStatus={liveStatus}
        isLive={isLive}
      />

      {/* Awaiting-input inline form */}
      {awaitingInput && inspection?.current?.runId && (
        <div className="border-t border-white/10 p-2">
          <AwaitingInputForm
            runId={inspection.current.runId}
            question={inspection.current.inputQuestion}
            onSubmitted={() => setRefetchNonce((n) => n + 1)}
          />
        </div>
      )}

      {/* Chat input footer — only for real agents */}
      {isReal && (
        <form
          onSubmit={onChat}
          className="flex flex-col gap-1 border-t border-white/10 bg-black/40 p-2"
        >
          {/* Attachment chips */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {attachments.map((a, i) => (
                <span
                  key={i}
                  className="flex items-center gap-1 rounded bg-white/10 px-2 py-0.5 font-mono text-[10px] text-white/70"
                >
                  <span>📎</span>
                  <span className="max-w-[120px] truncate">{a.name}</span>
                  <button
                    type="button"
                    onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                    className="ml-0.5 text-white/40 hover:text-white"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="flex items-center gap-1">
            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={onFileChange}
            />
            {/* Attach button */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy || uploading}
              title="Attach file"
              className="shrink-0 rounded border border-white/20 bg-white/5 px-1.5 py-1 text-xs text-white/50 hover:bg-white/10 hover:text-white/80 disabled:opacity-40"
            >
              {uploading ? "⏳" : "📎"}
            </button>
            <input
              type="text"
              value={chatText}
              onChange={(e) => setChatText(e.target.value)}
              placeholder={
                awaitingInput
                  ? "reply above…"
                  : chatPending
                  ? "sending…"
                  : isLive
                  ? `${agentName} is working… (your message will queue)`
                  : `talk to ${agentName}…`
              }
              disabled={busy}
              className="flex-1 rounded border border-white/20 bg-black/60 px-2 py-1 font-mono text-xs outline-none focus:border-white/40 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={busy || (!chatText.trim() && attachments.length === 0)}
              className="rounded border border-white/20 bg-white/10 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-white hover:bg-white/20 disabled:opacity-40"
            >
              {chatPending ? "…" : "send"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
