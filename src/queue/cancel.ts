/**
 * Cancel handling for the pipeline runner — extracted from pipeline-runner.ts so that
 * route handlers (routes/stories/jobs.ts) can call requestJobCancel without importing
 * the entire pipeline module.
 *
 * The Maps are module-level singletons shared with pipeline-runner.ts — this is the
 * right pattern for a singleton scan loop, but means the module is effectively a global.
 */
import type Database from 'better-sqlite3'
import { cancelJob, finishJob } from '../db/job-store.js'
import { fillTextGeneration } from '../db/text-store.js'
import { getJobBuffer, publishDone, publishCancelled } from './job-events.js'
import { JobCancelledError } from '../inference/featherless.js'
import type { GenerationOptions } from '../services/settings-space-registry.js'

/** Tracks which fallback candidate is actively streaming for a job — read on user cancel to finish telemetry. */
export const streamingModels = new Map<string, string>()

/** One AbortController per currently-running job, so a cancel request can actually abort its in-flight Featherless call instead of just flipping a DB flag. Populated when a job is claimed, deleted in its executor's `finally`. */
export const runningControllers = new Map<string, AbortController>()

export function beginCancellableWorkerJob(jobId: string): AbortController {
  const controller = new AbortController()
  runningControllers.set(jobId, controller)
  return controller
}

export function endCancellableWorkerJob(jobId: string): void {
  runningControllers.delete(jobId)
}

/**
 * Aborts a running job's in-flight call. Returns false if the job isn't currently running here
 * (already terminal, still pending, or a job type with no mid-flight cancel support) — callers
 * should fall back to marking it cancelled directly in that case.
 *
 * Horde jobs deliberately fall into the "no mid-flight cancel support" bucket — explicit scope
 * decision (2026-07-03): a request that's already submitted just runs to completion.
 */
export function requestJobCancel(jobId: string): boolean {
  const controller = runningControllers.get(jobId)
  if (!controller) return false
  controller.abort(new JobCancelledError())
  return true
}

/**
 * User hit Stop. If final content had started streaming, commit the partial reply as a normal
 * completion; otherwise discard the in-flight turn (thinking-only / prefill).
 */
export function handleStreamingCancel(
  db: Database.Database,
  jobId: string,
  targetTextId: string,
  startedAt: number,
  options?: {
    genOptions?: GenerationOptions
    onPartialCommit?: (partial: string) => void
  },
): void {
  const partial = getJobBuffer(jobId)?.text?.trim()
  if (partial) {
    const model = streamingModels.get(jobId) ?? 'unknown'
    streamingModels.delete(jobId)
    const tokenEstimate = Math.ceil(partial.length / 4)
    const metrics: Record<string, unknown> = {
      elapsedMs: Date.now() - startedAt,
      tokenEstimate,
      truncated: true,
    }
    if (options?.genOptions) metrics.toggles = options.genOptions
    fillTextGeneration(db, targetTextId, {
      genPackage: partial,
      genMetrics: JSON.stringify(metrics),
    })
    options?.onPartialCommit?.(partial)
    finishJob(db, jobId, 'done', undefined, {
      model,
      tokenEstimate,
      elapsedMs: Date.now() - startedAt,
    })
    publishDone(jobId, partial)
  } else {
    streamingModels.delete(jobId)
    cancelJob(db, jobId)
    publishCancelled(jobId)
  }
}
