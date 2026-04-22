/**
 * Centralized polling intervals for the entire app.
 *
 * Instead of scattering magic numbers like 3000 or 5000 across components,
 * import from here. Tune in one place, affect everywhere.
 */

// ─── Client-side (UI components) ────────────────────────────────────────────

/** Roster status polling — agent busy/idle/queue depth */
export const ROSTER_POLL_MS = 5_000;

/** Notification center — new alerts, tool approvals, awaiting input */
export const NOTIFICATION_POLL_MS = 3_000;

/** Active groupchats overlay — polls for running groupchats */
export const ACTIVE_GROUPCHATS_POLL_MS = 3_000;

/** Groupchat tab — conversation state (round status, messages) */
export const GROUPCHAT_STATE_POLL_MS = 1_500;

/** Groupchat tab — timeline events (who spoke, when) */
export const GROUPCHAT_TIMELINE_POLL_MS = 2_000;

/** Error log panel */
export const ERROR_LOG_POLL_MS = 5_000;

/** Usage tracker — token/context consumption */
export const USAGE_POLL_MS = 15_000;

// ─── Server-side (agent runner) ─────────────────────────────────────────────

/** Agent runner — polling for tool approval / user input responses */
export const RUNNER_APPROVAL_POLL_MS = 2_000;

/** SSE stream — run event polling for live output */
export const STREAM_POLL_MS = 250;
