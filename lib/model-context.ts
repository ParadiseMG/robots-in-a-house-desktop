/**
 * Model-aware context window limits and warning threshold.
 * Used by Station.tsx (⚠ overlay) and AgentHoverCard.
 */

export const MODEL_MAX_TOKENS: Record<string, number> = {
  "claude-opus-4-6": 200_000,
  "claude-sonnet-4-5": 1_000_000,
  "claude-haiku-4-5-20251001": 200_000,
};

const DEFAULT_MAX = 200_000;

/**
 * Returns true when `used` tokens is ≥80% of the model's known context window.
 * Falls back to 200k if model is unknown or null.
 */
export function isContextWarning(
  model: string | null | undefined,
  used: number,
): boolean {
  const max = model ? (MODEL_MAX_TOKENS[model] ?? DEFAULT_MAX) : DEFAULT_MAX;
  return used / max >= 0.8;
}

/**
 * Returns the context max for a model string, or the default if unknown.
 */
export function modelMaxTokens(model: string | null | undefined): number {
  return model ? (MODEL_MAX_TOKENS[model] ?? DEFAULT_MAX) : DEFAULT_MAX;
}
