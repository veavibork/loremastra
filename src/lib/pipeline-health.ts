/**
 * Periodic pipeline health snapshots written to data/pipeline-health.log.
 * Lightweight append-only JSON — same format as outbound-requests.log.
 * Only records when a snapshot callback is provided.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import path from 'node:path'

const LOG_PATH = path.resolve(process.cwd(), 'data', 'pipeline-health.log')
const MAX_ENTRIES = 200
const MAX_LOG_BYTES = 256 * 1024

export interface HealthSnapshot {
  at: string
  activeJobs: number
  pendingJobs: number
  slotsUsed: number
  slotsMax: number
  hordeJobsRunning: number
  trackedStories: number
}

function appendLine(obj: HealthSnapshot): void {
  try {
    const line = JSON.stringify(obj)
    if (!existsSync(LOG_PATH)) writeFileSync(LOG_PATH, '')
    appendFileSync(LOG_PATH, line + '\n')
    const size = statSync(LOG_PATH).size
    if (size > MAX_LOG_BYTES) trimLog()
  } catch {
    // Best-effort — never break the caller.
  }
}

function trimLog(): void {
  const lines = readFileSync(LOG_PATH, 'utf-8').split('\n').filter(Boolean)
  const trimmed = lines.slice(-MAX_ENTRIES)
  writeFileSync(LOG_PATH, trimmed.join('\n') + (trimmed.length ? '\n' : ''))
}

let interval: ReturnType<typeof setInterval> | null = null

/**
 * Start periodic snapshots. `getSnapshot` is called each tick — it should
 * be a fast synchronous function that reads the current pipeline state.
 */
export function startHealthSnapshots(
  getSnapshot: () => Omit<HealthSnapshot, 'at'>,
  intervalMs = 60_000,
): void {
  if (interval) return
  interval = setInterval(() => {
    appendLine({ at: new Date().toISOString(), ...getSnapshot() })
  }, intervalMs)
  interval.unref() // don't keep the process alive
}

export function stopHealthSnapshots(): void {
  if (interval) {
    clearInterval(interval)
    interval = null
  }
}
