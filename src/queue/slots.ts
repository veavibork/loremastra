/**
 * Gates job dispatch on Featherless's real account-wide concurrency
 * (src/queue/concurrency-feed.ts) rather than a purely local guess. The feed only updates every
 * ~2s while the scan loop ticks every 500ms (SCAN_INTERVAL_MS in pipeline-runner.ts), so jobs
 * this process has just dispatched are tracked as local "reservations" layered on top of the
 * feed's numbers until the feed has had time to catch up — otherwise several scan ticks in a
 * row could each see the same stale "free" snapshot and burst past the real limit. Falls back
 * to a fixed local-only counter when the feed is unavailable (no API key, network trouble, etc).
 */
import { getConcurrencySnapshot, isFeedHealthy } from "./concurrency-feed.js";

const FALLBACK_MAX_SLOTS = 4;

// Reservations older than this are trusted to have been picked up by the feed (3x its ~2s
// cadence — generous margin, same reasoning as concurrency-feed.ts's staleness window).
const RESERVATION_TTL_MS = 6_000;

// Live reservations are swept by age (see RESERVATION_TTL_MS) since the feed itself will pick
// them up eventually. Fallback reservations have no such backing feed to reconcile against, so
// they're held until explicitly released — otherwise a TTL sweep would silently hand out
// capacity that's still actually in use.
const liveReservations = new Map<string, { cost: number; reservedAt: number }>();
const fallbackReservations = new Map<string, number>();

function sweepLiveReservations(): void {
  const cutoff = Date.now() - RESERVATION_TTL_MS;
  for (const [jobId, r] of liveReservations) {
    if (r.reservedAt < cutoff) liveReservations.delete(jobId);
  }
}

function sum(costs: Iterable<number>): number {
  let total = 0;
  for (const cost of costs) total += cost;
  return total;
}

export function tryAcquireSlot(jobId: string, cost: number): boolean {
  if (isFeedHealthy()) {
    sweepLiveReservations();
    const snap = getConcurrencySnapshot()!;
    const remaining = snap.limit - snap.usedCost - sum([...liveReservations.values()].map((r) => r.cost));
    if (remaining < cost) return false;
    liveReservations.set(jobId, { cost, reservedAt: Date.now() });
    return true;
  }

  const inUse = sum(fallbackReservations.values());
  if (inUse + cost > FALLBACK_MAX_SLOTS) return false;
  fallbackReservations.set(jobId, cost);
  return true;
}

export function releaseSlot(jobId: string): void {
  liveReservations.delete(jobId);
  fallbackReservations.delete(jobId);
}

export function getQueueStatus(): { mode: "live" | "fallback"; used: number; max: number } {
  if (isFeedHealthy()) {
    const snap = getConcurrencySnapshot()!;
    const reserved = sum([...liveReservations.values()].map((r) => r.cost));
    return { mode: "live", used: snap.usedCost + reserved, max: snap.limit };
  }
  return { mode: "fallback", used: sum(fallbackReservations.values()), max: FALLBACK_MAX_SLOTS };
}
