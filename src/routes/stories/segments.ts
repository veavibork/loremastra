import { Hono } from 'hono'
import type { AppVariables } from '../../middleware/session-guard.js'
import { getBookByType } from '../../db/book-store.js'
import {
  getStoryToDateSegment,
  setStoryToDateSegmentContent,
  setStoryToDateSegmentName,
} from '../../db/story-to-date-store.js'
import {
  enqueueEligibleStoryToDateJob,
  enqueuePendingStoryToDateJobs,
  enqueuePendingStoryToDateNameJobs,
  requeueStoryToDateSegment,
  removeStoryToDateSegment,
  updateStoryToDateCoverageThroughPost,
} from '../../services/story-to-date/index.js'
import { buildStoryToDateView } from '../../services/story-to-date/view.js'
import { openTrackedStoryDb } from '../../services/story-ops.js'

export const segmentsRoute = new Hono<{ Variables: AppVariables }>()

segmentsRoute.get('/:id/story-to-date', (c) => {
  const storyDb = openTrackedStoryDb(c.req.param('id'))
  const logbook = getBookByType(storyDb, 'logbook')
  if (!logbook) return c.json({ error: 'logbook not found' }, 404)
  return c.json(buildStoryToDateView(storyDb, logbook.id))
})

segmentsRoute.post('/:id/story-to-date/enqueue', (c) => {
  const storyId = c.req.param('id')
  const storyDb = openTrackedStoryDb(storyId)
  const logbook = getBookByType(storyDb, 'logbook')
  if (!logbook) return c.json({ error: 'logbook not found' }, 404)
  enqueueEligibleStoryToDateJob(storyDb, c.get('userId'), logbook.id, storyId)
  enqueuePendingStoryToDateJobs(storyDb, c.get('userId'), logbook.id)
  return c.json({ view: buildStoryToDateView(storyDb, logbook.id) })
})

segmentsRoute.post('/:id/story-to-date/:segmentId/requeue', (c) => {
  const storyDb = openTrackedStoryDb(c.req.param('id'))
  const segment = getStoryToDateSegment(storyDb, c.req.param('segmentId'))
  if (!segment) return c.json({ error: 'segment not found' }, 404)
  try {
    requeueStoryToDateSegment(storyDb, c.get('userId'), segment.id)
    const logbook = getBookByType(storyDb, 'logbook')!
    return c.json({ ok: true, view: buildStoryToDateView(storyDb, logbook.id) })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

segmentsRoute.post('/:id/story-to-date/backfill-names', (c) => {
  const storyDb = openTrackedStoryDb(c.req.param('id'))
  const logbook = getBookByType(storyDb, 'logbook')
  if (!logbook) return c.json({ error: 'logbook not found' }, 404)
  enqueuePendingStoryToDateNameJobs(storyDb, c.get('userId'), logbook.id)
  return c.json({ view: buildStoryToDateView(storyDb, logbook.id) })
})

segmentsRoute.patch('/:id/story-to-date/:segmentId', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    content?: string
    name?: string
    coverageThroughIcPost?: number
  }
  const storyDb = openTrackedStoryDb(c.req.param('id'))
  const segment = getStoryToDateSegment(storyDb, c.req.param('segmentId'))
  if (!segment) return c.json({ error: 'segment not found' }, 404)
  const logbook = getBookByType(storyDb, 'logbook')!
  try {
    if (typeof body.content === 'string')
      setStoryToDateSegmentContent(storyDb, segment.id, body.content)
    if (typeof body.name === 'string') setStoryToDateSegmentName(storyDb, segment.id, body.name)
    if (body.coverageThroughIcPost !== undefined) {
      updateStoryToDateCoverageThroughPost(
        storyDb,
        segment.id,
        logbook.id,
        body.coverageThroughIcPost,
      )
    }
    return c.json({ view: buildStoryToDateView(storyDb, logbook.id) })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

segmentsRoute.delete('/:id/story-to-date/:segmentId', async (c) => {
  const storyId = c.req.param('id')
  const storyDb = openTrackedStoryDb(storyId)
  const segment = getStoryToDateSegment(storyDb, c.req.param('segmentId'))
  if (!segment) return c.json({ error: 'segment not found' }, 404)
  const logbook = getBookByType(storyDb, 'logbook')
  if (!logbook) return c.json({ error: 'logbook not found' }, 404)
  const deleteLater = c.req.query('deleteLater') === 'true'
  try {
    removeStoryToDateSegment(storyDb, c.get('userId'), logbook.id, storyId, segment.id, {
      deleteLaterSegments: deleteLater,
    })
    return c.json({ ok: true, view: buildStoryToDateView(storyDb, logbook.id) })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})
