import { NextResponse } from "next/server";

const RUNNER_URL = process.env.RUNNER_URL ?? "http://127.0.0.1:3101";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: runId } = await params;
  const body = (await req.json()) as { reply?: string };
  if (typeof body.reply !== "string") {
    return NextResponse.json({ error: "missing reply" }, { status: 400 });
  }
  try {
    const res = await fetch(
      `${RUNNER_URL}/runs/${encodeURIComponent(runId)}/reply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply: body.reply }),
      },
    );
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `runner unreachable: ${msg}` },
      { status: 502 },
    );
  }
}
