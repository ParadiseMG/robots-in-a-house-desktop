import { NextResponse } from "next/server";
import { withErrorReporting } from "@/lib/api-error-handler";

const RUNNER_URL = process.env.RUNNER_URL ?? "http://127.0.0.1:3101";

export const POST = withErrorReporting("POST /api/runs", async (req: Request) => {
  const body = (await req.json()) as {
    assignmentId?: string;
    agentId?: string;
    officeSlug?: string;
    prompt?: string;
  };
  if (!body.assignmentId || !body.agentId || !body.officeSlug || !body.prompt) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }
  try {
    const res = await fetch(`${RUNNER_URL}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
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
});
