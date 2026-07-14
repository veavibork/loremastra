import type { ActiveJob } from '../api'
import type { PendingReply } from './StoryViewReducer'

/** Wall-clock anchor for elapsed labels — job creation, or run start once the worker picks it up. */
export function jobElapsedAnchor(job: ActiveJob): number {
  return new Date(job.startedAt ?? job.createdAt).getTime()
}

/** Keep the oldest known anchor so reconnect/phase sync never resets the visible timer. */
export function stableElapsedAnchor(pending: PendingReply, proseJob: ActiveJob): number {
  return Math.min(pending.startedAt, jobElapsedAnchor(proseJob))
}

export function pendingStatusLabel(pending: PendingReply): string {
  if (pending.progress) return pending.progress
  const elapsed = Math.max(0, Math.round((Date.now() - pending.startedAt) / 1000))
  const queueHint =
    pending.waitPhase !== 'memory' &&
    pending.waitPhase !== 'prefill' &&
    pending.lastProseStatus === 'pending'
      ? ', queued'
      : ''
  if (pending.waitPhase === 'prefill') {
    const runAnchor = pending.runningStartedAt ?? pending.startedAt
    const runningElapsed = Math.max(0, Math.round((Date.now() - runAnchor) / 1000))
    const est = pending.prefillEstimateSec ?? 30
    const remaining = Math.max(0, est - runningElapsed)
    return remaining > 0 ? `Prefilling… (~${remaining}s)` : 'Prefilling…'
  }
  if (pending.waitPhase === 'generating' && !pending.text.trim()) {
    return `Generating… (${elapsed}s${queueHint})`
  }
  if (pending.thinking?.trim() && !pending.text.trim()) {
    return `Reasoning… (${elapsed}s${queueHint})`
  }
  if (pending.waitPhase === 'memory') {
    return `Memory update in progress… (${elapsed}s)`
  }
  return `Thinking… (${elapsed}s${queueHint})`
}
