import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AppVariables } from '../../middleware/session-guard.js'
import {
  getJob,
  listRecentJobs,
  listActiveJobs,
  cancelJob,
  agentRoleForJobType,
} from '../../db/job-store.js'
import { getText } from '../../db/text-store.js'
import { requestJobCancel } from '../../queue/cancel.js'
import { clearJobEphemeralState } from '../../queue/dispatch.js'
import {
  subscribeJob,
  getJobBuffer,
  publishCancelled,
  type JobEvent,
} from '../../queue/job-events.js'
import { publishStoryDataChanged } from '../../queue/story-events.js'
import { openTrackedStoryDb } from '../../services/story-ops.js'

export const jobsRoute = new Hono<{ Variables: AppVariables }>()

jobsRoute.get('/:id/jobs', (c) => {
  const storyDb = openTrackedStoryDb(c.req.param('id'))
  return c.json({
    jobs: listRecentJobs(storyDb).map((j) => ({
      ...j,
      agentRole: agentRoleForJobType(j.jobType),
      // Live wait/retry label for an in-flight job (memory-wait, provider-busy backoff, model
      // fallback) — same buffer the story view's SSE label reads, so the Queue tab shows WHY
      // a running job is sitting there instead of a bare "running".
      progress: j.status === 'running' ? (getJobBuffer(j.id)?.progress ?? null) : null,
    })),
  })
})

/**
 * Jobs still in flight for this story — lets a freshly (re)mounted client find a generation
 * it isn't already watching (e.g. after closing and reopening the story tab) and reattach to
 * its stream. Registered before the `:jobId` route below so "active" isn't swallowed as an id.
 */
jobsRoute.get('/:id/jobs/active', (c) => {
  const storyDb = openTrackedStoryDb(c.req.param('id'))
  return c.json({ jobs: listActiveJobs(storyDb) })
})

jobsRoute.get('/:id/jobs/:jobId', (c) => {
  const storyDb = openTrackedStoryDb(c.req.param('id'))
  const job = getJob(storyDb, c.req.param('jobId'))
  if (!job) return c.json({ error: 'job not found' }, 404)
  return c.json({ job })
})

/**
 * Pending jobs (not yet claimed) have no in-flight call to abort — mark cancelled directly.
 * Running jobs are aborted via requestJobCancel; the executor's own catch/finally in
 * dispatch.ts does the actual DB update, publishCancelled, and slot release once the
 * abort propagates, so this route doesn't race it by also writing the cancelled status itself.
 */
jobsRoute.post('/:id/jobs/:jobId/cancel', (c) => {
  const storyId = c.req.param('id')
  const storyDb = openTrackedStoryDb(storyId)
  const jobId = c.req.param('jobId')
  const job = getJob(storyDb, jobId)
  if (!job) return c.json({ error: 'job not found' }, 404)
  if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
    return c.json({ job })
  }
  if (job.status === 'pending') {
    cancelJob(storyDb, jobId)
    // Pending jobs never reach dispatch (where guidance/options are normally consumed and cleared),
    // so clear their ephemeral in-memory state here or it leaks for the process lifetime.
    clearJobEphemeralState(jobId)
    publishCancelled(jobId)
    publishStoryDataChanged(storyId, 'jobs')
    return c.json({ ok: true })
  }
  const aborted = requestJobCancel(jobId)
  if (!aborted) {
    // Running but has no in-memory controller to abort. A Horde job genuinely runs to completion
    // server-side (no mid-flight cancel by design) — say so. But a non-Horde job with no
    // controller is a zombie: its executor already exited without finalizing (or was lost), so
    // there's nothing live to abort — mark it cancelled directly instead of dead-ending the user
    // on a 409 with no way out of a stuck "running" post.
    if (job.hordeRequestId) {
      return c.json({ error: "this job type can't be cancelled mid-generation" }, 409)
    }
    cancelJob(storyDb, jobId)
    publishCancelled(jobId)
    publishStoryDataChanged(storyId, 'jobs')
    return c.json({ ok: true, reaped: true })
  }
  return c.json({ ok: true })
})

/**
 * Subscribes to the job's event bus BEFORE checking its current status.
 * Both operations are synchronous with no await between them, so on Node's
 * single-threaded event loop the job cannot transition states in the gap —
 * this is what avoids the "connection opened, nothing ever arrives" failure
 * mode we found in lorepebble's queue.
 */
jobsRoute.get('/:id/jobs/:jobId/stream', (c) => {
  const storyId = c.req.param('id')
  const jobId = c.req.param('jobId')
  const storyDb = openTrackedStoryDb(storyId)

  return streamSSE(c, async (sse) => {
    let settled = false
    const finish = async (event: JobEvent | { type: 'error'; message: string }) => {
      if (settled) return
      settled = true
      clearInterval(heartbeat)
      await sse.writeSSE({ data: JSON.stringify(event) })
      await sse.writeSSE({ data: '[DONE]' })
    }

    // Long generations can sit silent between tokens for a while; an idle connection with no
    // bytes flowing is what an idle-socket timeout (browser/OS/AV) can kill without either side
    // seeing an "error" worth reacting to. A raw SSE comment line (ignored by EventSource's
    // onmessage) keeps the socket demonstrably alive without changing the event contract.
    const heartbeat = setInterval(() => {
      void sse.write(': ping\n\n')
    }, 15000)

    await new Promise<void>((resolve) => {
      const unsubscribe = subscribeJob(jobId, (event) => {
        // Only genuinely terminal events end the stream. Everything else — streaming tokens AND
        // non-terminal lifecycle signals like 'claimed'/'started' — is forwarded and the
        // connection stays open. (A prior whitelist here misclassified 'claimed'/'started' as
        // terminal, so if the client happened to be subscribed when the job was claimed, the SSE
        // closed immediately and no tokens/done ever arrived — the intermittent "stuck on
        // Queued…" bug. Client ignores event types it has no handler for.)
        if (event.type === 'done' || event.type === 'error' || event.type === 'cancelled') {
          unsubscribe()
          void finish(event).then(resolve)
          return
        }
        void sse.writeSSE({ data: JSON.stringify(event) })
      })

      // Client gone (tab closed, EventSource.close(), reconnect superseded this socket): no
      // terminal job event will ever settle this stream, so tear down here — without this, the
      // subscription and the 15s heartbeat live until the job ends, and forever for a job that
      // never reaches a terminal state. One leaked pair per abandoned connection.
      sse.onAbort(() => {
        if (settled) return
        settled = true
        clearInterval(heartbeat)
        unsubscribe()
        resolve()
      })

      const job = getJob(storyDb, jobId)
      if (!job) {
        unsubscribe()
        void finish({ type: 'error', message: 'job not found' }).then(resolve)
        return
      }
      if (job.status === 'cancelled') {
        unsubscribe()
        void finish({ type: 'cancelled' }).then(resolve)
        return
      }
      // A failed job must surface as an error, not a silent 'done' — reporting it as done left a
      // reattaching client (reopened tab) rendering the dead page as a normal completion with no
      // error banner. The client's own reconcile path (web/src/api/jobs.ts) already maps
      // failed → error; this mirrors it.
      if (job.status === 'failed') {
        unsubscribe()
        void finish({ type: 'error', message: job.error ?? 'job failed' }).then(resolve)
        return
      }
      if (job.status === 'done') {
        unsubscribe()
        const text = job.targetTextId ? getText(storyDb, job.targetTextId) : null
        void finish({ type: 'done', fullText: text?.genPackage ?? '' }).then(resolve)
        return
      }
      if (job.inputTokenEstimate != null) {
        void sse.writeSSE({
          data: JSON.stringify({ type: 'meta', inputTokenEstimate: job.inputTokenEstimate }),
        })
      }
      const buffered = getJobBuffer(jobId)
      if (job.status === 'pending' && !buffered) {
        void sse.writeSSE({ data: JSON.stringify({ type: 'queued' }) })
      }
      if (buffered && (buffered.text || buffered.thinking || buffered.progress)) {
        void sse.writeSSE({
          data: JSON.stringify({
            type: 'sync',
            text: buffered.text,
            thinking: buffered.thinking,
            progress: buffered.progress,
          }),
        })
      }
    })
  })
})
