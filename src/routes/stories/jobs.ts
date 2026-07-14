import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AppVariables } from '../../middleware/session-guard.js'
import { getJob, listRecentJobs, listActiveJobs, cancelJob } from '../../db/job-store.js'
import { getText } from '../../db/text-store.js'
import { requestJobCancel } from '../../queue/cancel.js'
import {
  subscribeJob,
  getJobBuffer,
  publishCancelled,
  type JobEvent,
} from '../../queue/job-events.js'
import { openTrackedStoryDb } from '../../services/story-ops.js'

export const jobsRoute = new Hono<{ Variables: AppVariables }>()

jobsRoute.get('/:id/jobs', (c) => {
  const storyDb = openTrackedStoryDb(c.req.param('id'))
  return c.json({ jobs: listRecentJobs(storyDb) })
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
  const storyDb = openTrackedStoryDb(c.req.param('id'))
  const jobId = c.req.param('jobId')
  const job = getJob(storyDb, jobId)
  if (!job) return c.json({ error: 'job not found' }, 404)
  if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
    return c.json({ job })
  }
  if (job.status === 'pending') {
    cancelJob(storyDb, jobId)
    publishCancelled(jobId)
    return c.json({ ok: true })
  }
  const aborted = requestJobCancel(jobId)
  if (!aborted) {
    // Running but has no controller — a job type that doesn't support mid-flight cancel yet
    // (compress/archive, and now Horde too — see requestJobCancel's comment). Nothing to do
    // but say so; it'll resolve on its own soon either way.
    return c.json({ error: "this job type can't be cancelled mid-generation" }, 409)
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
        if (
          event.type === 'token' ||
          event.type === 'thinking' ||
          event.type === 'progress' ||
          event.type === 'meta' ||
          event.type === 'reset'
        ) {
          void sse.writeSSE({ data: JSON.stringify(event) })
          return
        }
        unsubscribe()
        void finish(event).then(resolve)
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
      if (job.status === 'done' || job.status === 'failed') {
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
      // Still pending/running: replay whatever's accumulated so far (a reconnecting client —
      // e.g. the story tab was closed and reopened mid-generation — sees the post at its
      // current stage instead of nothing until it lands). Safe against the subscribe-then-read
      // race above: no await happened between subscribeJob and this read, so nothing else could
      // have run on Node's single thread to add tokens the buffer read would miss.
      const buffered = getJobBuffer(jobId)
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
