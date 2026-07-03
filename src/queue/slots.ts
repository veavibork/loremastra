/**
 * Gates job dispatch on Featherless's real account-wide concurrency
 * (src/queue/concurrency-feed.ts) rather than a purely local guess. The feed only updates every
 * ~2s while the scan loop ticks every 500ms (SCAN_INTERVAL_MS in pipeline-runner.ts), so jobs
 * this process has just dispatched are tracked as local "reservations" layered on top of the
 * feed's numbers until the feed has had time to catch up — otherwise several scan ticks in a
 * row could each see the same stale "free" snapshot and burst past the real limit. Falls back
 * to a fixed local-only counter when the feed is unavailable (no API key, network trouble, etc).
 *
 * Keyed by userId — each user has their own Featherless account/key now, so each has an
 * independent concurrency limit; one user's usage must never count against another's.
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
const liveReservations = new Map<string, Map<string, { cost: number; reservedAt: number }>>();
const fallbackReservations = new Map<string, Map<string, number>>();

function liveFor(userId: string): Map<string, { cost: number; reservedAt: number }> {
  let map = liveReservations.get(userId);
  if (!map) {
    map = new Map();
    liveReservations.set(userId, map);
  }
  return map;
}

function fallbackFor(userId: string): Map<string, number> {
  let map = fallbackReservations.get(userId);
  if (!map) {
    map = new Map();
    fallbackReservations.set(userId, map);
  }
  return map;
}

function sweepLiveReservations(userId: string): void {
  const cutoff = Date.now() - RESERVATION_TTL_MS;
  for (const [jobId, r] of liveFor(userId)) {
    if (r.reservedAt < cutoff) liveFor(userId).delete(jobId);
  }
}

function sum(costs: Iterable<number>): number {
  let total = 0;
  for (const cost of costs) total += cost;
  return total;
}

export function tryAcquireSlot(userId: string, jobId: string, cost: number): boolean {
  if (isFeedHealthy(userId)) {
    sweepLiveReservations(userId);
    const snap = getConcurrencySnapshot(userId)!;
    const remaining = snap.limit - snap.usedCost - sum([...liveFor(userId).values()].map((r) => r.cost));
    if (remaining < cost) return false;
    liveFor(userId).set(jobId, { cost, reservedAt: Date.now() });
    return true;
  }

  const inUse = sum(fallbackFor(userId).values());
  if (inUse + cost > FALLBACK_MAX_SLOTS) return false;
  fallbackFor(userId).set(jobId, cost);
  return true;
}

export function releaseSlot(userId: string, jobId: string): void {
  liveFor(userId).delete(jobId);
  fallbackFor(userId).delete(jobId);
}

export function getQueueStatus(userId: string): { mode: "live" | "fallback"; used: number; max: number } {
  if (isFeedHealthy(userId)) {
    const snap = getConcurrencySnapshot(userId)!;
    const reserved = sum([...liveFor(userId).values()].map((r) => r.cost));
    return { mode: "live", used: snap.usedCost + reserved, max: snap.limit };
  }
  return { mode: "fallback", used: sum(fallbackFor(userId).values()), max: FALLBACK_MAX_SLOTS };
}
