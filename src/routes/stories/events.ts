import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AppVariables } from '../../middleware/session-guard.js'
import { subscribeStoryEvents } from '../../queue/story-events.js'

export const eventsRoute = new Hono<{ Variables: AppVariables }>()

/**
 * Story-scoped data-change stream — one connection per open app, held for as long as the story
 * is loaded. Unlike the per-job stream (jobs.ts) this has no terminal event: it ends only when
 * the client disconnects, so the onAbort teardown is the ONLY cleanup path and must release
 * both the subscription and the heartbeat.
 */
eventsRoute.get('/:id/events', (c) => {
  const storyId = c.req.param('id')

  return streamSSE(c, async (sse) => {
    const heartbeat = setInterval(() => {
      void sse.write(': ping\n\n')
    }, 15000)

    await new Promise<void>((resolve) => {
      const unsubscribe = subscribeStoryEvents(storyId, (event) => {
        void sse.writeSSE({ data: JSON.stringify(event) })
      })
      sse.onAbort(() => {
        clearInterval(heartbeat)
        unsubscribe()
        resolve()
      })
    })
  })
})
