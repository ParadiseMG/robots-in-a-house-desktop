import { NextResponse } from "next/server";
import {
  AgentBuilderError,
  createAgent,
  isValidOfficeSlug,
} from "@/lib/agent-builder";
import { withErrorReporting } from "@/lib/api-error-handler";

export const POST = withErrorReporting("POST /api/agents/create", async (req: Request) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  if (!isValidOfficeSlug(b.officeSlug)) {
    return NextResponse.json({ error: "invalid officeSlug" }, { status: 400 });
  }
  if (typeof b.name !== "string" || typeof b.role !== "string") {
    return NextResponse.json({ error: "name and role required" }, { status: 400 });
  }
  const sprite = typeof b.sprite === "string" ? b.sprite : undefined;
  const model = typeof b.model === "string" ? b.model : undefined;
  const gridX = typeof b.gridX === "number" ? b.gridX : undefined;
  const gridY = typeof b.gridY === "number" ? b.gridY : undefined;

  try {
    const result = await createAgent({
      officeSlug: b.officeSlug,
      name: b.name,
      role: b.role,
      sprite,
      model,
      gridX,
      gridY,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof AgentBuilderError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
