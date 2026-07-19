import { EventEmitter } from 'node:events'
import type { RetryEvent } from '../inference/featherless.js'

/**
 * Bridges the background pipeline runner (which calls Featherless) to any SSE
 * clients watching a given job. This is what lets the client open its stream
 * only once a job is actually running, per the handshake design, instead of
 * making its own inference call.
 */
const emitter = new EventEmitter()
emitter.setMaxListeners(0)

/**
 * Accumulated text/progress per in-flight job, so a client that (re)connects mid-generation
 * (e.g. the story tab was closed and reopened) can catch up on everything emitted before it
 * started listening, instead of seeing nothing until the next token or the job's own "done".
 * Cleared once the job reaches a terminal state.
 */
interface JobBuffer {
  text: string
  thinking?: string
  progress?: string
}
const buffers = new Map<string, JobBuffer>()

export function publishToken(jobId: string, text: string): void {
  const buf = buffers.get(jobId) ?? { text: '' }
  buf.text += text
  buffers.set(jobId, buf)
  emitter.emit(jobId, { type: 'token', text })
}

export function publishThinking(jobId: string, text: string): void {
  const buf = buffers.get(jobId) ?? { text: '' }
  buf.thinking = (buf.thinking ?? '') + text
  buffers.set(jobId, buf)
  emitter.emit(jobId, { type: 'thinking', text })
}

/** Clears accumulated stream snapshot before an internal retry or fallback model switch. */
export function publishStreamReset(
  jobId: string,
  parts: { thinking?: boolean; text?: boolean },
  label?: string,
): void {
  const buf = buffers.get(jobId) ?? { text: '' }
  if (parts.thinking) buf.thinking = undefined
  if (parts.text) buf.text = ''
  if (label) buf.progress = label
  else if (parts.thinking || parts.text) buf.progress = undefined
  buffers.set(jobId, buf)
  emitter.emit(jobId, {
    type: 'reset',
    thinking: !!parts.thinking,
    text: !!parts.text,
    label,
  })
}

/** Emitted when a job is created and enters the pending state — the client shows a "Queued…" label. */
export function publishQueued(jobId: string): void {
  emitter.emit(jobId, { type: 'queued' })
}

/** Emitted when a job starts running (prefill begins) — carries the token estimate if known. */
export function publishPrefill(jobId: string, inputTokenEstimate?: number): void {
  emitter.emit(jobId, { type: 'prefill', inputTokenEstimate })
}

/** For non-streaming jobs (e.g. the Editor's tool-calling setup turn) that have no tokens to emit but do have real intermediate steps worth narrating instead of a dead "…". */
export function publishProgress(jobId: string, label: string): void {
  const buf = buffers.get(jobId) ?? { text: '' }
  buf.progress = label
  buffers.set(jobId, buf)
  emitter.emit(jobId, { type: 'progress', label })
}

/** Model ids read like "deepseek-ai/DeepSeek-V4-Pro" — the org prefix is noise in a progress label. */
function shortModel(model: string): string {
  return model.split('/').pop() ?? model
}

/**
 * Adapter from withModelFallback/withTransientRetry's retry events to this job's progress
 * label — makes in-job retries (provider 500/503 backoff, cross-model fallback) visible in
 * the story view's wait label and the Queue tab instead of happening silently.
 */
export function retryProgressPublisher(jobId: string): (event: RetryEvent) => void {
  return (event) => {
    if (event.kind === 'transient-retry') {
      publishProgress(
        jobId,
        `Provider busy (${event.status}) — retrying ${shortModel(event.model)} in ${Math.round(event.delayMs / 1000)}s (retry ${event.attempt})…`,
      )
    } else {
      publishProgress(
        jobId,
        `${shortModel(event.fromModel)} unavailable — trying ${shortModel(event.toModel)}…`,
      )
    }
  }
}

/** Snapshot of whatever's accumulated for a job so far — read by the stream route when a client connects, to replay it as a single "sync" event ahead of live tokens. */
export function getJobBuffer(jobId: string): JobBuffer | undefined {
  return buffers.get(jobId)
}

/**
 * `followUp`, when present, tells the client a second job/page was queued as a direct
 * consequence of this one finishing (the pre-kickoff setup turn's dual-pass worldbook-authoring
 * job) — the client can chain a second watch onto it so that message appears live too, instead
 * of a generic poll.
 */
export function publishDone(
  jobId: string,
  fullText: string,
  followUp?: { jobId: string; pageId: string },
): void {
  buffers.delete(jobId)
  emitter.emit(jobId, { type: 'done', fullText, followUp })
}

export function publishError(jobId: string, message: string): void {
  buffers.delete(jobId)
  emitter.emit(jobId, { type: 'error', message })
}

/** A user-initiated cancel, distinct from `error` so the client can clear the pending reply without surfacing it as a failure. */
export function publishCancelled(jobId: string): void {
  buffers.delete(jobId)
  emitter.emit(jobId, { type: 'cancelled' })
}
// publishJobCreated used to live here, emitting a 'created' event on the per-job channel — but
// no client can be subscribed to a job's channel before it learns the job id from the creating
// request's response, so every emission fired into an empty room. Job creation now publishes a
// 'jobs' data-changed ping on the story-scoped bus (story-events.ts) instead, where the Queue
// tab's listener exists before the job does.

export function publishJobClaimed(jobId: string): void {
  emitter.emit(jobId, { type: 'claimed', at: new Date().toISOString() })
}

export function publishJobStarted(jobId: string, inputTokenEstimate?: number): void {
  // A queued-phase progress label ("Waiting for memory update…") is obsolete the moment the job
  // runs — drop it from the buffer so a client attaching mid-generation doesn't get it replayed
  // in its catch-up 'sync'. Live clients clear their own label on the 'prefill' event below.
  const buf = buffers.get(jobId)
  if (buf?.progress) {
    buf.progress = undefined
    buffers.set(jobId, buf)
  }
  emitter.emit(jobId, { type: 'started', at: new Date().toISOString() })
  emitter.emit(jobId, { type: 'prefill', inputTokenEstimate })
}

export type JobEvent =
  | { type: 'token'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'progress'; label: string }
  | { type: 'meta'; inputTokenEstimate: number }
  | { type: 'reset'; thinking: boolean; text: boolean; label?: string }
  | {
      type: 'sync'
      text: string
      thinking?: string
      progress?: string
      inputTokenEstimate?: number
    }
  | { type: 'done'; fullText: string; followUp?: { jobId: string; pageId: string } }
  | { type: 'error'; message: string }
  | { type: 'cancelled' }
  | { type: 'queued' }
  | { type: 'prefill'; inputTokenEstimate?: number }
  | { type: 'claimed'; at: string }
  | { type: 'started'; at: string }

export function subscribeJob(jobId: string, onEvent: (event: JobEvent) => void): () => void {
  emitter.on(jobId, onEvent)
  return () => emitter.off(jobId, onEvent)
}
