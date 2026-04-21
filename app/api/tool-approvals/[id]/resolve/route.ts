import { NextRequest, NextResponse } from "next/server";
import { getToolApproval, approveToolUsage, denyToolUsage } from "@/server/db";

export const dynamic = "force-dynamic";

/**
 * POST /api/tool-approvals/[id]/resolve
 *
 * Approve or deny a specific tool approval request and notify the waiting agent.
 * Body: { action: "approve" | "deny", reason?: string }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: approvalId } = await params;
    const body = await request.json();
    const { action, reason } = body;

    if (!action || (action !== "approve" && action !== "deny")) {
      return NextResponse.json({ error: "Action must be 'approve' or 'deny'" }, { status: 400 });
    }

    // Get the approval to ensure it exists and is pending
    const approval = getToolApproval(approvalId);
    if (!approval) {
      return NextResponse.json({ error: "Approval not found" }, { status: 404 });
    }

    if (approval.status !== "pending") {
      return NextResponse.json({ error: "Approval already processed" }, { status: 409 });
    }

    // Update the approval status in the database
    let success: boolean;
    if (action === "approve") {
      success = approveToolUsage(approvalId);
    } else {
      success = denyToolUsage(approvalId, reason);
    }

    if (!success) {
      return NextResponse.json({ error: "Failed to update approval" }, { status: 500 });
    }

    // Notify the waiting agent runner via the shared waiters map
    const { toolApprovalWaiters } = await import("@/server/tool-approval-waiters");
    const waiter = toolApprovalWaiters.get(approvalId);
    if (waiter) {
      waiter({
        approved: action === "approve",
        reason: action === "deny" ? reason : undefined
      });
      toolApprovalWaiters.delete(approvalId);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to resolve tool approval:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}