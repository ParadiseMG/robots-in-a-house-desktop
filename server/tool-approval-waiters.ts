/**
 * Shared in-memory map for tool-approval resolve callbacks.
 *
 * Extracted from agent-runner so that API routes can import the waiters
 * without pulling in the full runner (which depends on node:fs via
 * error-reporter and breaks Next.js bundling).
 */

export type ToolApprovalResult = { approved: boolean; reason?: string };

export const toolApprovalWaiters = new Map<
  string,
  (result: ToolApprovalResult) => void
>();
