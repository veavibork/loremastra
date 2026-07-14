import { Hono } from 'hono'
import { sValidator } from '@hono/standard-validator'
import { z } from 'zod'
import { validationHook } from '../../lib/validation-hook.js'
import type { AppVariables } from '../../middleware/session-guard.js'
import { getBookByType } from '../../db/book-store.js'
import {
  buildMemoryManifest,
  buildMemorySummary,
  enqueueMemoryPipeline,
  runMemoryBackfill,
} from '../../services/context/manifest.js'
import { openTrackedStoryDb } from '../../services/story-ops.js'

export const contextRoute = new Hono<{ Variables: AppVariables }>()

const backfillSchema = z.object({
  enqueueJobs: z.boolean().optional(),
})

/** Compact context health — story-to-date coverage, no per-post dump. */
contextRoute.get('/:id/context/summary', (c) => {
  const storyDb = openTrackedStoryDb(c.req.param('id')!)
  const logbook = getBookByType(storyDb, 'logbook')
  if (!logbook) return c.json({ error: 'logbook not found' }, 404)
  return c.json(buildMemorySummary(storyDb, logbook.id))
})

/** Full per-post context manifest (stamps, compress validity, tag counts, archives). */
contextRoute.get('/:id/context/manifest', (c) => {
  const storyDb = openTrackedStoryDb(c.req.param('id')!)
  const logbook = getBookByType(storyDb, 'logbook')
  if (!logbook) return c.json({ error: 'logbook not found' }, 404)
  return c.json(buildMemoryManifest(storyDb, logbook.id))
})

/** Repair stamps and optionally enqueue jobs. */
contextRoute.post(
  '/:id/context/backfill',
  sValidator('json', backfillSchema, validationHook),
  (c) => {
    const body = c.req.valid('json')
    const storyDb = openTrackedStoryDb(c.req.param('id')!)
    const logbook = getBookByType(storyDb, 'logbook')
    if (!logbook) return c.json({ error: 'logbook not found' }, 404)
    return c.json(
      runMemoryBackfill(storyDb, c.get('userId'), logbook.id, c.req.param('id')!, {
        enqueueJobs: body.enqueueJobs,
      }),
    )
  },
)

/** Queue eligible jobs only — no stamp or tag repair. */
contextRoute.post('/:id/context/enqueue', (c) => {
  const storyDb = openTrackedStoryDb(c.req.param('id')!)
  const logbook = getBookByType(storyDb, 'logbook')
  if (!logbook) return c.json({ error: 'logbook not found' }, 404)
  const pendingMemoryJobs = enqueueMemoryPipeline(
    storyDb,
    c.get('userId'),
    logbook.id,
    c.req.param('id')!,
  )
  return c.json({ pendingMemoryJobs, summary: buildMemorySummary(storyDb, logbook.id) })
})
