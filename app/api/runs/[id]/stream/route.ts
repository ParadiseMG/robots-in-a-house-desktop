import { db } from "@/server/db";
import { STREAM_POLL_MS } from "@/lib/polling-constants";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: runId } = await params;

  const encoder = new TextEncoder();

  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      let lastEventId = 0;
      let done = false;
      const startedAt = Date.now();
      const MAX_LIFETIME_MS = 30 * 60 * 1000; // 30 minutes

      const send = (data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      const tick = () => {
        if (closed) return;
        try {
          const rows = db()
            .prepare(
              `SELECT id, ts, kind, payload FROM run_events
               WHERE run_id = ? AND id > ? ORDER BY id ASC LIMIT 200`,
            )
            .all(runId, lastEventId) as Array<{
              id: number;
              ts: number;
              kind: string;
              payload: string;
            }>;
          for (const r of rows) {
            lastEventId = r.id;
            const payload = JSON.parse(r.payload) as Record<string, unknown>;
            send({ id: r.id, ts: r.ts, kind: r.kind, payload });
            if (r.kind === "status" && (payload.status === "done" || payload.status === "error" || payload.status === "interrupted")) {
              done = true;
            }
          }
        } catch (err) {
          console.error("[stream] tick error", err);
        }
        if (done) {
          send({ kind: "close" });
          controller.close();
          closed = true;
          return;
        }
        if (Date.now() - startedAt > MAX_LIFETIME_MS) {
          send({ kind: "timeout", message: "stream max lifetime exceeded" });
          controller.close();
          closed = true;
          return;
        }
        setTimeout(tick, STREAM_POLL_MS);
      };

      // prime with a retry hint and kick the loop
      controller.enqueue(encoder.encode(`retry: 1000\n\n`));
      tick();
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
