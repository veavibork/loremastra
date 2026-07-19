/**
 * Model format probe runner — step 4 of docs/providers/format-probe-plan.md.
 *
 * Drains the global model_format_profiles queue (src/db/model-format-profile-store.ts):
 * one probe at a time, gated by the same slots.ts reservations as story jobs so the Queue
 * tab's holder list attributes it ("model-probe"). Probes are NOT story jobs — the per-story
 * jobs table requires a story-scoped target a model probe doesn't have — so this runner is
 * the global counterpart to dispatch.ts, deliberately tiny: probes are rare, sequential, and
 * user-initiated.
 *
 * A probe run is 8+ sequential Featherless calls with up-to-45s 429 backoffs, i.e. minutes of
 * held slots on purpose (accepted cost, per plan). The abort path releases the slot
 * immediately; Featherless may still count the aborted call until its generation finishes
 * server-side (same known limitation as story jobs).
 */
import { join } from 'node:path'
import { getGlobalDb } from '../db/global-db.js'
import {
  claimNextPendingProbe,
  unclaimProbe,
  finishProbe,
  type ModelFormatProfileRow,
} from '../db/model-format-profile-store.js'
import { dataDir } from '../db/data-paths.js'
import { getDecryptedFeatherlessKey } from '../db/user-store.js'
import { runFormatProbe } from '../inference/format-probe.js'
import { ensureConcurrencyFeedForUser } from './concurrency-feed.js'
import { tryAcquireSlot, releaseSlot } from './slots.js'
import { createLogger } from '../inference/outbound-telemetry.js'

const SCAN_INTERVAL_MS = 2000

interface RunningProbe {
  controller: AbortController
  progress: string | null
  startedAt: number
}

let timer: NodeJS.Timeout | null = null
// Single-flight: one probe process-wide. Keyed state anyway so progress/abort lookups are
// by (provider, model) like everything else about profiles.
const running = new Map<string, RunningProbe>()

function probeKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`
}

/** Live progress label for a running probe ("Probe 3/8: thinking-on run 1…"), null otherwise. */
export function getProbeProgress(provider: string, modelId: string): string | null {
  return running.get(probeKey(provider, modelId))?.progress ?? null
}

/** Aborts a running probe's in-flight call; the runner's finally handles status + slot release. */
export function abortRunningProbe(provider: string, modelId: string): boolean {
  const entry = running.get(probeKey(provider, modelId))
  if (!entry) return false
  entry.controller.abort()
  return true
}

/** Abort every running probe this user requested — the Queue tab panic button's probe half. */
export function panicStopProbes(userId: string): number {
  const db = getGlobalDb()
  let aborted = 0
  for (const key of running.keys()) {
    const sep = key.indexOf(':')
    const provider = key.slice(0, sep)
    const modelId = key.slice(sep + 1)
    const row = db
      .prepare(`SELECT requested_by FROM model_format_profiles WHERE provider = ? AND model_id = ?`)
      .get(provider, modelId) as { requested_by: string } | undefined
    if (row?.requested_by === userId && abortRunningProbe(provider, modelId)) aborted++
  }
  return aborted
}

export function startProbeRunner(): void {
  if (timer) return
  timer = setInterval(scanOnce, SCAN_INTERVAL_MS)
}

export function stopProbeRunner(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/**
 * The slot reservation should match the model's real per-call concurrency cost when the user
 * has a config row recording it (agents.ts keeps concurrency_cost synced from the catalog);
 * unknown models reserve 1 and lean on the probe's own 429 backoff if that underestimates.
 */
function slotCostForModel(userId: string, provider: string, modelId: string): number {
  const row = getGlobalDb()
    .prepare(
      `SELECT MAX(concurrency_cost) AS cost FROM model_configs
       WHERE user_id = ? AND provider = ? AND model = ?`,
    )
    .get(userId, provider, modelId) as { cost: number | null } | undefined
  return row?.cost ?? 1
}

function scanOnce(): void {
  if (running.size > 0) return
  const db = getGlobalDb()

  let claimed: ModelFormatProfileRow | null = null
  try {
    claimed = claimNextPendingProbe(db)
  } catch (err) {
    createLogger({ jobType: 'model-probe' }).error('probe claim failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }
  if (!claimed) return

  const { provider, modelId, requestedBy } = claimed

  if (provider !== 'featherless') {
    finishProbe(db, provider, modelId, {
      status: 'failed',
      error: `probing is only implemented for featherless (got ${provider})`,
    })
    return
  }

  const apiKey = getDecryptedFeatherlessKey(db, requestedBy)
  if (!apiKey) {
    finishProbe(db, provider, modelId, {
      status: 'failed',
      error: 'no Featherless API key configured for the requesting user',
    })
    return
  }

  const cost = slotCostForModel(requestedBy, provider, modelId)
  const slotId = `probe:${probeKey(provider, modelId)}`
  ensureConcurrencyFeedForUser(requestedBy, apiKey)
  if (
    !tryAcquireSlot(requestedBy, slotId, cost, {
      jobType: 'model-probe',
      agentRole: null,
      storyId: '',
      storyName: modelId,
    })
  ) {
    unclaimProbe(db, provider, modelId)
    return
  }

  const key = probeKey(provider, modelId)
  const entry: RunningProbe = {
    controller: new AbortController(),
    progress: null,
    startedAt: Date.now(),
  }
  running.set(key, entry)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const slug = modelId.replace(/[^a-zA-Z0-9.-]/g, '_')
  const artifactDir = join(dataDir(), 'experiments', 'format-probe', `${stamp}-${slug}`)
  const log = createLogger({ jobType: 'model-probe' })

  void runFormatProbe(modelId, {
    apiKey,
    signal: entry.controller.signal,
    artifactDir,
    onProgress: (label) => {
      entry.progress = label
    },
  })
    .then(({ profile, observations }) => {
      // Zero successful calls means there is no profile, just a record of failures (bad key,
      // model gone, provider down) — storing it as 'done' would hand consumers a garbage
      // "none-observed" shape that looks authoritative. Found live: an all-401 run.
      if (profile.callsSucceeded === 0) {
        const firstError = observations.find((o) => !o.ok)
        const message = firstError
          ? `all ${profile.callsAttempted} probe calls failed (HTTP ${firstError.httpStatus}): ${firstError.error ?? 'unknown error'}`
          : 'all probe calls failed'
        finishProbe(db, provider, modelId, { status: 'failed', error: message.slice(0, 500) })
        log.error('model probe failed', { model: modelId, error: message })
        return
      }
      finishProbe(db, provider, modelId, { status: 'done', profile, artifactDir })
      log.info('model probe finished', {
        model: modelId,
        shape: profile.shape,
        callsSucceeded: profile.callsSucceeded,
      })
    })
    .catch((err: unknown) => {
      if (entry.controller.signal.aborted) {
        finishProbe(db, provider, modelId, { status: 'cancelled', error: 'cancelled' })
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      finishProbe(db, provider, modelId, { status: 'failed', error: message })
      log.error('model probe failed', { model: modelId, error: message })
    })
    .finally(() => {
      running.delete(key)
      releaseSlot(requestedBy, slotId)
    })
}
