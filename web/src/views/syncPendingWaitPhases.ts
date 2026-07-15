import type { ActiveJob } from '../api'
import type { PendingReply } from './StoryViewReducer'
import { stableElapsedAnchor } from './StoryViewHelpers'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MEMORY_JOB_TYPES = new Set(['story-to-date', 'story-to-date-fold'])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Conservative TTFT guess — intentionally high so early tokens feel like a win. */
export function estimatePrefillSeconds(inputTokens: number | null | undefined): number {
  if (!inputTokens || inputTokens <= 0) return 30
  return Math.max(10, Math.min(120, Math.ceil(inputTokens / 200)))
}

export function mergeJobMeta(
  pending: PendingReply,
  job: ActiveJob,
): Pick<PendingReply, 'inputTokenEstimate' | 'prefillEstimateSec' | 'runningStartedAt'> {
  const inputTokenEstimate = job.inputTokenEstimate ?? pending.inputTokenEstimate
  const runningStartedAt = job.startedAt
    ? new Date(job.startedAt).getTime()
    : pending.runningStartedAt
  const prefillEstimateSec =
    inputTokenEstimate != null
      ? estimatePrefillSeconds(inputTokenEstimate)
      : pending.prefillEstimateSec
  return { inputTokenEstimate, prefillEstimateSec, runningStartedAt }
}

export function isMemoryJobRunning(jobs: ActiveJob[]): boolean {
  return jobs.some((j) => MEMORY_JOB_TYPES.has(j.jobType) && j.status === 'running')
}

// ---------------------------------------------------------------------------
// Wait-phase state machine
// ---------------------------------------------------------------------------

/**
 * Pure function: takes the previous pendingReplies + current active jobs and
 * computes new pendingReplies with updated waitPhase/elapsed/meta fields for
 * entries that are still waiting (no streamed text or progress).
 *
 * Returns `prev` unchanged (identity) when nothing changed, allowing React to
 * skip re-renders.
 */
export function syncPendingWaitPhases(
  prev: Record<string, PendingReply>,
  jobs: ActiveJob[],
): Record<string, PendingReply> {
  const memoryBlocking = isMemoryJobRunning(jobs)
  let changed = false
  const next = { ...prev }

  for (const [pageId, pending] of Object.entries(prev)) {
    const proseJob = jobs.find((j) => j.id === pending.jobId)
    if (!proseJob) continue

    const startedAt = stableElapsedAnchor(pending, proseJob)
    const meta = mergeJobMeta(pending, proseJob)

    if (proseJob.status === 'pending' && memoryBlocking) {
      if (pending.waitPhase !== 'memory') {
        next[pageId] = {
          ...pending,
          ...meta,
          waitPhase: 'memory',
          startedAt,
          lastProseStatus: proseJob.status,
        }
        changed = true
      }
      continue
    }

    if (pending.waitPhase === 'memory') {
      const waitPhase = pending.thinking?.trim() ? 'reasoning' : 'prefill'
      next[pageId] = { ...pending, ...meta, waitPhase, startedAt, lastProseStatus: proseJob.status }
      changed = true
      continue
    }

    if (proseJob.status === 'running' && !pending.thinking?.trim() && !pending.text.trim()) {
      const waitPhase = 'prefill'
      if (
        pending.waitPhase !== waitPhase ||
        pending.lastProseStatus !== proseJob.status ||
        pending.startedAt !== startedAt ||
        pending.prefillEstimateSec !== meta.prefillEstimateSec
      ) {
        next[pageId] = {
          ...pending,
          ...meta,
          waitPhase,
          startedAt,
          lastProseStatus: proseJob.status,
        }
        changed = true
      }
      continue
    }

    if (
      proseJob.status === 'running' &&
      pending.text.trim() &&
      pending.waitPhase !== 'generating'
    ) {
      next[pageId] = {
        ...pending,
        ...meta,
        waitPhase: 'generating',
        startedAt,
        lastProseStatus: proseJob.status,
      }
      changed = true
      continue
    }

    if (pending.thinking?.trim() && !pending.text.trim()) {
      if (pending.waitPhase !== 'reasoning' || pending.lastProseStatus !== proseJob.status) {
        next[pageId] = {
          ...pending,
          ...meta,
          waitPhase: 'reasoning',
          startedAt,
          lastProseStatus: proseJob.status,
        }
        changed = true
      }
      continue
    }

    if (!pending.waitPhase) {
      const waitPhase =
        proseJob.status === 'running'
          ? 'prefill'
          : proseJob.status === 'pending'
            ? undefined
            : 'prefill'
      next[pageId] = {
        ...pending,
        ...meta,
        waitPhase: waitPhase ?? pending.waitPhase,
        startedAt,
        lastProseStatus: proseJob.status,
      }
      changed = true
    } else if (
      pending.lastProseStatus !== proseJob.status ||
      pending.startedAt !== startedAt ||
      pending.inputTokenEstimate !== meta.inputTokenEstimate
    ) {
      next[pageId] = { ...pending, ...meta, startedAt, lastProseStatus: proseJob.status }
      changed = true
    }
  }

  return changed ? next : prev
}
