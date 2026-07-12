/** Error formatting and logging — used by the global error handler and catch blocks. */
import { createLogger } from "../inference/outbound-log.js";

/** Extracts a human-readable message from any thrown value. */
export function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Log an unhandled error with context for post-mortem debugging. */
export function logUnhandledError(
  context: { storyId?: string; jobId?: string; source: string },
  err: unknown
): void {
  const log = createLogger(context);
  if (err instanceof Error) {
    log.error(formatError(err), { stack: err.stack });
  } else {
    log.error(formatError(err));
  }
}