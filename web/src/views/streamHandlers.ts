import type { ActiveJob, JobStreamEvent, LogPage } from '../api'
import type { PendingReply, StoryViewAction } from './StoryViewReducer'

// ---------------------------------------------------------------------------
// Context passed to every stream event handler
// ---------------------------------------------------------------------------

export interface StreamHandlerCtx {
  dispatch: (action: StoryViewAction) => void
  /** Mutable snapshot of pendingReplies kept current every render — the SSE callback
   *  outlives its creating render, so reading state through this ref is mandatory
   *  for sync/done handlers that need the latest accumulated text/thinking. */
  pendingRef: { current: Record<string, PendingReply> }
  /** Accumulates thinking text independently of reducer state — PENDING_RESET clears
   *  the reducer's thinking field but not this ref, so the done handler can save the
   *  full reasoning trace even if a reset event arrived between the last token and done. */
  accumulatedThinkingRef: { current: Record<string, string> }
  /** Called by terminal handlers (done/error/cancelled) to close the EventSource. */
  closeConnection: (pageId: string) => void
  storyId: string
  pageId: string
  jobId: string
  refresh: () => Promise<LogPage>
  fetchActiveJobs: (storyId: string) => Promise<ActiveJob[]>
  /** Self-reference for followUp chaining — the done handler calls this when the
   *  server signals a follow-up job was queued as a consequence of this one. */
  watchJob: (jobId: string, pageId: string, onDone?: () => void, startedAt?: number) => void
  onDone: (() => void) | undefined
  setError: (error: string | null) => void
  estimatePrefill: (inputTokens: number | null | undefined) => number
  saveReasoningTrace: (storyId: string, pageId: string, thinking: string) => void
}

export type StreamEventHandler = (event: JobStreamEvent, ctx: StreamHandlerCtx) => void

// ---------------------------------------------------------------------------
// Individual handlers — one per event type
// ---------------------------------------------------------------------------

function handleToken(
  event: { type: 'token'; text: string },
  { dispatch, pageId }: StreamHandlerCtx,
): void {
  dispatch({ type: 'PENDING_TOKEN', pageId, text: event.text })
}

function handleThinking(
  event: { type: 'thinking'; text: string },
  { dispatch, pageId, accumulatedThinkingRef }: StreamHandlerCtx,
): void {
  dispatch({ type: 'PENDING_THINKING', pageId, thinking: event.text })
  accumulatedThinkingRef.current[pageId] =
    (accumulatedThinkingRef.current[pageId] ?? '') + event.text
}

function handleMeta(
  event: { type: 'meta'; inputTokenEstimate: number },
  { dispatch, pageId }: StreamHandlerCtx,
): void {
  dispatch({ type: 'PENDING_META', pageId, inputTokenEstimate: event.inputTokenEstimate })
}

function handleReset(
  event: { type: 'reset'; thinking: boolean; text: boolean; label?: string },
  { dispatch, pageId }: StreamHandlerCtx,
): void {
  dispatch({
    type: 'PENDING_RESET',
    pageId,
    text: event.text,
    thinking: event.thinking,
    label: event.label,
  })
}

function handleProgress(
  event: { type: 'progress'; label: string },
  { dispatch, pageId }: StreamHandlerCtx,
): void {
  dispatch({ type: 'PENDING_PROGRESS', pageId, label: event.label })
}

function handleSync(
  event: {
    type: 'sync'
    text: string
    thinking?: string
    progress?: string
    inputTokenEstimate?: number
  },
  { dispatch, pageId, pendingRef, estimatePrefill }: StreamHandlerCtx,
): void {
  const cur = pendingRef.current[pageId]
  if (!cur) return
  const hasText = !!event.text.trim()
  const hasThinking = !!event.thinking?.trim()
  const waitPhase = hasText ? 'generating' : hasThinking ? 'reasoning' : cur.waitPhase
  const prefillEstimateSec =
    event.inputTokenEstimate != null
      ? estimatePrefill(event.inputTokenEstimate)
      : cur.prefillEstimateSec
  dispatch({
    type: 'PENDING_TEXT_SNAPSHOT',
    pageId,
    text: event.text,
    thinking: event.thinking,
    progress: event.progress,
    inputTokenEstimate: event.inputTokenEstimate,
    prefillEstimateSec,
    waitPhase,
  })
}
function handleDone(
  event: { type: 'done'; fullText: string; followUp?: { jobId: string; pageId: string } },
  {
    dispatch,
    pageId,
    pendingRef,
    accumulatedThinkingRef,
    storyId,
    refresh,
    watchJob,
    onDone,
    setError,
    saveReasoningTrace,
    closeConnection,
  }: StreamHandlerCtx,
): void {
  const cur = pendingRef.current[pageId]
  const thinking = accumulatedThinkingRef.current[pageId] ?? cur?.thinking
  if (thinking?.trim()) saveReasoningTrace(storyId, pageId, thinking)
  // Don't drop the pending entry yet — entries[] still has this page's content as null
  // (refresh() below hasn't landed), so removing it here would flip shown.map's render to
  // its "…" placeholder for one render, collapsing the last post's height and, while
  // pinned to the bottom, getting .log's scrollTop clamped down by the browser. Keeping
  // the full streamed text on screen until refresh() actually has the real content means
  // the pending→shown handoff never has a gap to fall into.
  dispatch({ type: 'PENDING_DONE', pageId })
  void refresh()
    .then(() => {
      dispatch({ type: 'PENDING_REMOVE', pageId })
    })
    .catch((err) => {
      console.error('refresh after job done failed', err)
      setError(err instanceof Error ? err.message : String(err))
      dispatch({ type: 'PENDING_REMOVE', pageId })
    })
  // This job is finished, so close its own connection unconditionally (streamJob self-closes on
  // the [DONE] sentinel, but the activeConnections entry must be dropped too or it lingers dead).
  closeConnection(pageId)
  // Pre-kickoff setup turns are dual-pass — a second, separate worldbook-authoring message may
  // have been queued as a direct consequence of this one finishing. It streams on its OWN pageId,
  // so chain a watch onto it (a distinct connection) to show it live and highlighted.
  if (event.followUp) watchJob(event.followUp.jobId, event.followUp.pageId)
  onDone?.()
}

function handleError(
  event: { type: 'error'; message: string },
  {
    dispatch,
    pageId,
    setError,
    closeConnection,
    storyId,
    jobId,
    watchJob,
    refresh,
    fetchActiveJobs,
  }: StreamHandlerCtx,
): void {
  closeConnection(pageId)
  // Check if the job is still alive server-side before giving up.
  // The EventSource reconnect logic already retried — this is a permanent
  // transport failure, not a server-side job failure.
  void (async () => {
    try {
      const jobs = await fetchActiveJobs(storyId)
      const job = jobs.find((j) => j.id === jobId)
      if (job && (job.status === 'running' || job.status === 'pending')) {
        watchJob(jobId, pageId)
        return
      }
      // Job is terminal — pull final content and remove
      await refresh()
    } catch {
      // fetch failed — treat as terminal
    }
    dispatch({ type: 'PENDING_FAIL', pageId })
    setError(event.message)
  })()
}

function handleCancelled(
  _event: { type: 'cancelled' },
  { dispatch, pageId, closeConnection }: StreamHandlerCtx,
): void {
  closeConnection(pageId)
  dispatch({ type: 'PENDING_CANCELLED', pageId })
}

function handleQueued(_event: { type: 'queued' }, { dispatch, pageId }: StreamHandlerCtx): void {
  dispatch({ type: 'PENDING_PROGRESS', pageId, label: 'Queued…' })
}

function handlePrefill(
  event: { type: 'prefill'; inputTokenEstimate?: number },
  { dispatch, pageId }: StreamHandlerCtx,
): void {
  dispatch({ type: 'PENDING_PROGRESS', pageId, label: undefined })
  dispatch({ type: 'PENDING_META', pageId, inputTokenEstimate: event.inputTokenEstimate })
}

// ---------------------------------------------------------------------------
// Switch-table — maps event type strings to handlers
// ---------------------------------------------------------------------------

export const STREAM_HANDLERS: Record<string, StreamEventHandler> = {
  token: handleToken as StreamEventHandler,
  thinking: handleThinking as StreamEventHandler,
  meta: handleMeta as StreamEventHandler,
  reset: handleReset as StreamEventHandler,
  progress: handleProgress as StreamEventHandler,
  sync: handleSync as StreamEventHandler,
  done: handleDone as StreamEventHandler,
  error: handleError as StreamEventHandler,
  cancelled: handleCancelled as StreamEventHandler,
  queued: handleQueued as StreamEventHandler,
  prefill: handlePrefill as StreamEventHandler,
}
