/**
 * Gates job dispatch on Featherless's real account-wide concurrency
 * (src/queue/concurrency-feed.ts) rather than a purely local guess. The feed only updates every
 * ~2s while the scan loop ticks every 500ms (SCAN_INTERVAL_MS in dispatch.ts), so jobs
 * this process has just dispatched are tracked as local "reservations" layered on top of the
 * feed's numbers until the feed has had time to catch up — otherwise several scan ticks in a
 * row could each see the same stale "free" snapshot and burst past the real limit.
 *
 * Live reservations are held until releaseSlot() — never TTL-swept. Archive/Editor jobs run for
 * minutes; an age-based sweep (the old 6s TTL) dropped reservations while Featherless requests
 * were still in flight and caused 429s on cost-4 models.
 *
 * Keyed by userId — each user has their own Featherless account/key now, so each has an
 * independent concurrency limit; one user's usage must never count against another's.
 */
import { getConcurrencySnapshot, isFeedHealthy } from './concurrency-feed.js'

const FALLBACK_MAX_SLOTS = 4

/** What a reservation is for — carried so the Queue tab can attribute each held slot. */
export interface SlotHolderMeta {
  jobType: string
  agentRole: 'author' | 'editor' | 'worker' | null
  storyId: string
  storyName: string
}

export interface SlotHolder extends SlotHolderMeta {
  jobId: string
  cost: number
  reservedAt: number
}

interface Reservation {
  cost: number
  reservedAt: number
  meta: SlotHolderMeta | null
}

const liveReservations = new Map<string, Map<string, Reservation>>()
const fallbackReservations = new Map<string, Map<string, Reservation>>()

function liveFor(userId: string): Map<string, Reservation> {
  let map = liveReservations.get(userId)
  if (!map) {
    map = new Map()
    liveReservations.set(userId, map)
  }
  return map
}

function fallbackFor(userId: string): Map<string, Reservation> {
  let map = fallbackReservations.get(userId)
  if (!map) {
    map = new Map()
    fallbackReservations.set(userId, map)
  }
  return map
}

function sumCosts(reservations: Iterable<Reservation>): number {
  let total = 0
  for (const r of reservations) total += r.cost
  return total
}

export function tryAcquireSlot(
  userId: string,
  jobId: string,
  cost: number,
  meta: SlotHolderMeta | null = null,
): boolean {
  if (isFeedHealthy(userId)) {
    const snap = getConcurrencySnapshot(userId)!
    const reserved = sumCosts(liveFor(userId).values())
    const remaining = snap.limit - snap.usedCost - reserved
    if (remaining < cost) return false
    liveFor(userId).set(jobId, { cost, reservedAt: Date.now(), meta })
    return true
  }

  const inUse = sumCosts(fallbackFor(userId).values())
  if (inUse + cost > FALLBACK_MAX_SLOTS) return false
  fallbackFor(userId).set(jobId, { cost, reservedAt: Date.now(), meta })
  return true
}

export function releaseSlot(userId: string, jobId: string): void {
  liveFor(userId).delete(jobId)
  fallbackFor(userId).delete(jobId)
}

function holdersFor(userId: string): SlotHolder[] {
  const holders: SlotHolder[] = []
  for (const map of [liveFor(userId), fallbackFor(userId)]) {
    for (const [jobId, r] of map) {
      holders.push({
        jobId,
        cost: r.cost,
        reservedAt: r.reservedAt,
        jobType: r.meta?.jobType ?? 'unknown',
        agentRole: r.meta?.agentRole ?? null,
        storyId: r.meta?.storyId ?? '',
        storyName: r.meta?.storyName ?? '',
      })
    }
  }
  return holders.sort((a, b) => a.reservedAt - b.reservedAt)
}

export function getQueueStatus(userId: string): {
  mode: 'live' | 'fallback'
  used: number
  max: number
  /** Ground truth from the Featherless concurrency feed (live mode only) — includes requests it still counts after a client-side abort, and same-job retries. */
  providerUsedCost: number | null
  /** Sum of local reservations — every slot a job in this process currently holds. */
  reservedCost: number
  holders: SlotHolder[]
} {
  const holders = holdersFor(userId)
  const reservedCost = holders.reduce((n, h) => n + h.cost, 0)
  if (isFeedHealthy(userId)) {
    const snap = getConcurrencySnapshot(userId)!
    // `used` keeps its historical layered semantics (feed + reservations, deliberately
    // over-counting for safe gating); providerUsedCost/reservedCost/holders let the UI show
    // honest numbers instead.
    return {
      mode: 'live',
      used: snap.usedCost + reservedCost,
      max: snap.limit,
      providerUsedCost: snap.usedCost,
      reservedCost,
      holders,
    }
  }
  return {
    mode: 'fallback',
    used: reservedCost,
    max: FALLBACK_MAX_SLOTS,
    providerUsedCost: null,
    reservedCost,
    holders,
  }
}
