/**
 * Rate limiter for Horde API submissions. Horde has no account-wide concurrency
 * signal like Featherless's — this prevents bursting the shared anonymous pool
 * (2/sec per IP, 1.1s minimum spacing between submits). The scan loop retries
 * next tick (500ms) when a submission is rate-limited.
 *
 * There's no "release" — unlike the old in-flight cap, rate limiting is purely
 * time-based. The poll loop (scanHordeJobs) tracks in-flight jobs via
 * listRunningHordeJobs and handles completion/failure there.
 */

/** Minimum spacing between Horde submit calls (ms). */
const MIN_SUBMIT_SPACING_MS = 1100
/** Max submissions per 1-second window. */
const MAX_SUBMITS_PER_SECOND = 2

const recentSubmits: number[] = []
let lastSubmitAt = 0

/**
 * Returns true if a new Horde submission is allowed right now (rate-limit check).
 * Call this immediately before submitTextGeneration. Does NOT need a paired release.
 */
export function canSubmitHorde(): boolean {
  const now = Date.now()
  // Enforce minimum spacing between submits
  if (now - lastSubmitAt < MIN_SUBMIT_SPACING_MS) return false
  // Prune entries older than 1 second
  while (recentSubmits.length && recentSubmits[0]! < now - 1000) {
    recentSubmits.shift()
  }
  if (recentSubmits.length >= MAX_SUBMITS_PER_SECOND) return false
  return true
}

/** Records that a submission was made — call right after canSubmitHorde() returns true. */
export function recordHordeSubmit(): void {
  const now = Date.now()
  recentSubmits.push(now)
  lastSubmitAt = now
}
