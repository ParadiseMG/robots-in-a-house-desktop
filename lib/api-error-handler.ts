import { NextResponse } from "next/server";
import { insertError } from "@/server/db";

/**
 * Wrap a Next.js API route handler with error reporting.
 * Catches unhandled exceptions, logs them to the error_log table,
 * and returns a 500 JSON response.
 */
export function withErrorReporting<T extends unknown[]>(
  routeName: string,
  handler: (...args: T) => Promise<NextResponse>,
): (...args: T) => Promise<NextResponse> {
  return async (...args: T) => {
    try {
      return await handler(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack ?? null : null;

      // Best-effort insert — don't let DB errors mask the original
      try {
        insertError({
          source: "api",
          severity: "error",
          message: `${routeName}: ${message}`,
          stack,
          context: { route: routeName },
        });
      } catch {
        // fall through
      }

      console.error(`[api] ${routeName}:`, err);
      return NextResponse.json(
        { error: message },
        { status: 500 },
      );
    }
  };
}
