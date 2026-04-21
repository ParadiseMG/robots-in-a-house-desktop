import { NextRequest, NextResponse } from "next/server";
import {
  getPendingToolApprovals,
  approveToolUsage,
  denyToolUsage,
  getAgent
} from "@/server/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/tool-approvals
 *
 * Returns pending tool approval requests across all offices.
 * Query params:
 *   - office_slug: filter by office
 *   - agent_id: filter by agent
 */
export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const officeSlug = url.searchParams.get("office_slug") || undefined;
    const agentId = url.searchParams.get("agent_id") || undefined;

    const approvals = getPendingToolApprovals({ officeSlug, agentId });

    // Enrich with agent details
    const enriched = approvals.map(approval => {
      const agent = getAgent(approval.office_slug, approval.agent_id);
      return {
        ...approval,
        tool_input: JSON.parse(approval.tool_input),
        agentName: agent?.name ?? approval.agent_id,
        agentRole: agent?.role ?? "",
      };
    });

    return NextResponse.json({ approvals: enriched });
  } catch (error) {
    console.error("Failed to get tool approvals:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * POST /api/tool-approvals
 *
 * Approve or deny a tool usage request.
 * Body: { approval_id: string, action: "approve" | "deny", reason?: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { approval_id, action, reason } = body;

    if (!approval_id || !action) {
      return NextResponse.json({ error: "Missing approval_id or action" }, { status: 400 });
    }

    if (action !== "approve" && action !== "deny") {
      return NextResponse.json({ error: "Action must be 'approve' or 'deny'" }, { status: 400 });
    }

    let success: boolean;
    if (action === "approve") {
      success = approveToolUsage(approval_id);
    } else {
      success = denyToolUsage(approval_id, reason);
    }

    if (!success) {
      return NextResponse.json({ error: "Approval not found or already processed" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to process tool approval:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}