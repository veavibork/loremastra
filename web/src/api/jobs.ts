import { apiFetch, getSessionId, API_BASE } from './client.js'
import type { Job, ActiveJob, JobStreamEvent } from './types.js'

export async function fetchJobs(storyId: string, opts?: { background?: boolean }): Promise<Job[]> {
  const res = await apiFetch(`/api/stories/${storyId}/jobs`, {}, opts)
  const data = (await res.json()) as { jobs: Job[] }
  return data.jobs
}

export async function fetchSlots(opts?: {
  background?: boolean
}): Promise<{ used: number; max: number }> {
  const res = await apiFetch(`/api/debug/slots`, {}, opts)
  return res.json()
}

/** Panic button: stops every pending/running job across every story this user owns. */
export async function panicStopAllJobs(): Promise<{ aborted: number; reaped: number }> {
  const res = await apiFetch(`/api/debug/slots/panic`, { method: 'POST' })
  return res.json()
}

/**
 * Single job by id — for polling a specific long-running background job. Unlike fetchJobs
 * (capped to the 30 most recent), this can't lose track of the job if other jobs pile up
 * elsewhere in the story while it's still running.
 */
export async function fetchJob(
  storyId: string,
  jobId: string,
  opts?: { background?: boolean },
): Promise<Job | null> {
  const res = await apiFetch(`/api/stories/${storyId}/jobs/${jobId}`, {}, opts)
  const data = (await res.json()) as { job?: Job; error?: string }
  return data.job ?? null
}

export async function cancelJob(storyId: string, jobId: string): Promise<void> {
  const res = await apiFetch(`/api/stories/${storyId}/jobs/${jobId}/cancel`, { method: 'POST' })
  const data = await res.json()
  if (!res.ok && data.error) throw new Error(data.error)
}

/** In-flight jobs for a story — used to reattach to a generation still running after the story tab was closed and reopened. */
export async function fetchActiveJobs(storyId: string): Promise<ActiveJob[]> {
  const res = await apiFetch(`/api/stories/${storyId}/jobs/active`)
  const data = (await res.json()) as { jobs: ActiveJob[] }
  return data.jobs
}

/**
 * The stream route sends a periodic SSE comment as a heartbeat (see src/routes/stories.ts) so an
 * idle-socket timeout during a long, mostly-silent generation is unlikely — but if the
 * connection still drops before the final "done"/"error" message arrives, EventSource's
 * onerror gives no detail at all. Rather than leave the caller stuck forever (the "pending
 * reply never locks in" bug), reconcile against the job's own persisted status and either
 * reconnect (still in flight) or synthesize the terminal event (already resolved).
 */
export function streamJob(
  storyId: string,
  jobId: string,
  onEvent: (event: JobStreamEvent) => void,
): () => void {
  let closed = false
  let source: EventSource

  async function reconcile(attempt = 0) {
    if (closed) return
    try {
      const res = await apiFetch(`/api/stories/${storyId}/jobs/${jobId}`)
      const data = (await res.json()) as {
        job?: { status: string; error: string | null }
        error?: string
      }
      if (closed) return
      if (!res.ok || !data.job) {
        onEvent({ type: 'error', message: data.error ?? 'job not found' })
        return
      }
      if (data.job.status === 'pending' || data.job.status === 'running') {
        connect()
        return
      }
      if (data.job.status === 'done') {
        onEvent({ type: 'done', fullText: '' })
      } else if (data.job.status === 'cancelled') {
        onEvent({ type: 'cancelled' })
      } else {
        onEvent({ type: 'error', message: data.job.error ?? 'job failed' })
      }
    } catch (err) {
      if (closed) return
      const message = err instanceof Error ? err.message : String(err)
      const isNetwork = /Failed to fetch|NetworkError|network error|ERR_/i.test(message)
      if (isNetwork && attempt < 2) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1000 * (attempt + 1)))
        return reconcile(attempt + 1)
      }
      onEvent({ type: 'error', message })
    }
  }

  function connect() {
    // EventSource can't set custom headers, so the session id rides as a query param instead —
    // the guard checks both (see src/middleware/session-guard.ts).
    const sessionId = getSessionId()
    const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''
    source = new EventSource(`${API_BASE}/api/stories/${storyId}/jobs/${jobId}/stream${query}`)
    source.onmessage = (message) => {
      if (message.data === '[DONE]') {
        source.close()
        return
      }
      onEvent(JSON.parse(message.data) as JobStreamEvent)
    }
    source.onerror = () => {
      source.close()
      void reconcile()
    }
  }

  connect()
  return () => {
    closed = true
    source.close()
  }
}

export interface StoryDataEvent {
  type: 'data-changed'
  kind: 'worldbook' | 'segments' | 'jobs'
}

/**
 * Story-scoped data-change stream — held open for as long as the story is loaded (no terminal
 * event, unlike streamJob). Drives query invalidation for the Worldbook/Segments tabs instead
 * of fixed-interval polling. EventSource's native auto-reconnect is left in charge here: there
 * is no per-event state to reconcile, so on any drop we just let it retry and call onReconnect
 * once it's back — the caller refetches everything to cover events missed while disconnected.
 */
export function streamStoryEvents(
  storyId: string,
  onEvent: (event: StoryDataEvent) => void,
  onReconnect: () => void,
): () => void {
  const sessionId = getSessionId()
  const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''
  const source = new EventSource(`${API_BASE}/api/stories/${storyId}/events${query}`)
  let dropped = false
  source.onmessage = (message) => {
    onEvent(JSON.parse(message.data) as StoryDataEvent)
  }
  source.onerror = () => {
    dropped = true
  }
  source.onopen = () => {
    if (dropped) {
      dropped = false
      onReconnect()
    }
  }
  return () => source.close()
}

export type { Job, ActiveJob, JobStreamEvent } from './types.js'
