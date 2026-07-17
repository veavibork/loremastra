/**
 * Persistent backend connection to Featherless's real account-wide concurrency feed
 * (`GET /account/concurrency/stream` — no `/v1` prefix, confirmed in
 * docs/featherless-notes.md), so slot-acquisition can gate on ground truth instead of the
 * purely local counter in src/queue/slots.ts.
 *
 * Keyed by userId, not a single process-wide connection — each user now has their own
 * Featherless account/key, so each has its own independent concurrency limit. A connection is
 * opened lazily the first time a user's job is about to be dispatched (see
 * ensureConcurrencyFeedForUser, called from dispatch.ts) rather than at boot, since
 * there's no "the" key to connect with anymore. Docs: one event immediately on connect, then
 * every 2s.
 */
import { FEATHERLESS_BASE_URL, FEATHERLESS_USER_AGENT } from '../inference/featherless-config.js'

// FEATHERLESS_BASE_URL includes /v1 for chat/models endpoints; this endpoint lives at the bare host.
const CONCURRENCY_STREAM_URL = `${FEATHERLESS_BASE_URL.replace(/\/v1$/, '')}/account/concurrency/stream`

// A snapshot older than this many ms is treated as stale (4x the documented ~2s cadence —
// generous margin, consistent with this codebase's other timeout margins).
const STALE_AFTER_MS = 8_000

const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000]

export interface ConcurrencySnapshot {
  limit: number
  usedCost: number
  updatedAt: number
}

interface FeedState {
  apiKey: string
  snapshot: ConcurrencySnapshot | null
  reconnectAttempt: number
  reconnectTimer: NodeJS.Timeout | null
  abortController: AbortController | null
  stopped: boolean
}

const feeds = new Map<string, FeedState>()

export function getConcurrencySnapshot(userId: string): ConcurrencySnapshot | null {
  return feeds.get(userId)?.snapshot ?? null
}

export function isFeedHealthy(userId: string): boolean {
  const snapshot = feeds.get(userId)?.snapshot
  return !!snapshot && Date.now() - snapshot.updatedAt <= STALE_AFTER_MS
}

/** No-ops if already connected for this user with the same key; reconnects if the key changed (e.g. the user just replaced it). */
export function ensureConcurrencyFeedForUser(userId: string, apiKey: string): void {
  const existing = feeds.get(userId)
  if (existing && existing.apiKey === apiKey && !existing.stopped) return
  if (existing) stopFeed(existing)

  const state: FeedState = {
    apiKey,
    snapshot: null,
    reconnectAttempt: 0,
    reconnectTimer: null,
    abortController: null,
    stopped: false,
  }
  feeds.set(userId, state)
  connect(userId, state)
}

function stopFeed(state: FeedState): void {
  state.stopped = true
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer)
  state.reconnectTimer = null
  state.abortController?.abort()
  state.abortController = null
}

export function stopAllConcurrencyFeeds(): void {
  for (const state of feeds.values()) stopFeed(state)
  feeds.clear()
}

function scheduleReconnect(userId: string, state: FeedState): void {
  if (state.stopped || feeds.get(userId) !== state) return
  const delay =
    RECONNECT_DELAYS_MS[Math.min(state.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]
  state.reconnectAttempt++
  state.reconnectTimer = setTimeout(() => connect(userId, state), delay)
}

async function connect(userId: string, state: FeedState): Promise<void> {
  if (state.stopped) return
  if (!state.apiKey) {
    // No key configured — nothing to connect to, and nothing to retry: re-arming the reconnect
    // timer here just churned a setTimeout every 10s forever for keyless (e.g. Horde-only) users.
    // Callers see this via isFeedHealthy() staying false and fall back to the local counter;
    // ensureConcurrencyFeedForUser starts a fresh feed the moment a key appears, because the
    // stored state's key ('') won't match the new one.
    return
  }

  state.abortController = new AbortController()
  try {
    const response = await fetch(CONCURRENCY_STREAM_URL, {
      headers: {
        Authorization: `Bearer ${state.apiKey}`,
        'User-Agent': FEATHERLESS_USER_AGENT,
        Accept: 'text/event-stream',
      },
      signal: state.abortController.signal,
    })

    if (!response.ok || !response.body) {
      throw new Error(`concurrency stream request failed: ${response.status}`)
    }

    state.reconnectAttempt = 0 // connected successfully — reset backoff
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        try {
          const parsed = JSON.parse(payload) as { limit?: number; used_cost?: number }
          if (typeof parsed.limit === 'number' && typeof parsed.used_cost === 'number') {
            state.snapshot = {
              limit: parsed.limit,
              usedCost: parsed.used_cost,
              updatedAt: Date.now(),
            }
          }
        } catch {
          // ignore malformed SSE chunk
        }
      }
    }
  } catch (err) {
    if (!state.stopped) {
      console.error(
        `concurrency feed disconnected for user ${userId}:`,
        err instanceof Error ? err.message : err,
      )
    }
  } finally {
    state.abortController = null
    scheduleReconnect(userId, state)
  }
}
