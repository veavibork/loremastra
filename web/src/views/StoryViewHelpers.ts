import type { ActiveJob } from '../api'
import type { PendingReply } from './StoryViewReducer'

/** Wall-clock anchor for elapsed labels — job creation, or run start once the worker picks it up. */
export function jobElapsedAnchor(job: ActiveJob): number {
  return new Date(job.startedAt ?? job.createdAt).getTime()
}

/** Conservative TTFT guess — intentionally high so early tokens feel like a win. */
export function estimatePrefillSeconds(inputTokens: number | null | undefined): number {
  if (!inputTokens || inputTokens <= 0) return 30
  return Math.max(10, Math.min(120, Math.ceil(inputTokens / 200)))
}

export function pendingStatusLabel(pending: PendingReply): string {
  if (pending.progress) return pending.progress
  const elapsed = Math.max(0, Math.round((Date.now() - pending.startedAt) / 1000))
  if (pending.waitPhase === 'prefill') {
    const runAnchor = pending.runningStartedAt ?? pending.startedAt
    const runningElapsed = Math.max(0, Math.round((Date.now() - runAnchor) / 1000))
    const est = pending.prefillEstimateSec ?? 30
    const remaining = Math.max(0, est - runningElapsed)
    return remaining > 0 ? `Prefilling… (~${remaining}s)` : 'Prefilling…'
  }
  if (pending.waitPhase === 'generating' && !pending.text.trim()) {
    return `Generating… (${elapsed}s)`
  }
  if (pending.thinking?.trim() && !pending.text.trim()) {
    return `Reasoning… (${elapsed}s)`
  }
  return `Thinking… (${elapsed}s)`
}
