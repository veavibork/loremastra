import { Hono } from 'hono'
import { sValidator } from '@hono/standard-validator'
import { z } from 'zod'
import { validationHook } from '../../lib/validation-hook.js'
import type { AppVariables } from '../../middleware/session-guard.js'
import { getBookByType } from '../../db/book-store.js'
import {
  createWorldbookEntry,
  listWorldbookEntries,
  updateWorldbookEntry,
  setWorldbookEntryHidden,
} from '../../db/worldbook-store.js'
import { enqueueWorldbookCompactJob } from '../../services/worldbook/compact.js'
import { openTrackedStoryDb } from '../../services/story-ops.js'

export const worldbookRoute = new Hono<{ Variables: AppVariables }>()

const createEntrySchema = z.object({
  entryType: z.enum(['content', 'roster', 'memory']),
  content: z.string(),
})

const patchEntrySchema = z.object({
  content: z.string().optional(),
  hidden: z.boolean().optional(),
})

const compactSchema = z.object({
  entryType: z.enum(['content', 'roster', 'memory']).optional(),
  includeHidden: z.boolean().optional(),
})

worldbookRoute.get('/:id/worldbook', (c) => {
  const storyDb = openTrackedStoryDb(c.req.param('id')!)
  const worldbook = getBookByType(storyDb, 'worldbook')
  if (!worldbook) return c.json({ error: 'worldbook not found' }, 404)
  return c.json({ entries: listWorldbookEntries(storyDb, worldbook.id, { includeHidden: true }) })
})

worldbookRoute.post(
  '/:id/worldbook',
  sValidator('json', createEntrySchema, validationHook),
  (c) => {
    const { entryType, content } = c.req.valid('json')
    if (!content.trim()) return c.json({ error: 'entryType and content are required' }, 400)

    const storyDb = openTrackedStoryDb(c.req.param('id')!)
    const worldbook = getBookByType(storyDb, 'worldbook')
    if (!worldbook) return c.json({ error: 'worldbook not found' }, 404)

    try {
      const entry = createWorldbookEntry(storyDb, {
        bookId: worldbook.id,
        entryType,
        content,
      })
      return c.json({ entry })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  },
)

worldbookRoute.patch(
  '/:id/worldbook/:pageId',
  sValidator('json', patchEntrySchema, validationHook),
  (c) => {
    const body = c.req.valid('json')
    const storyDb = openTrackedStoryDb(c.req.param('id')!)
    const pageId = c.req.param('pageId')!

    try {
      if (typeof body.hidden === 'boolean') setWorldbookEntryHidden(storyDb, pageId, body.hidden)
      if (typeof body.content === 'string') {
        updateWorldbookEntry(storyDb, pageId, { content: body.content })
      }
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  },
)

/** Manual worldbook compaction — queued on the worker lane; shows in Logs → Queue. */
worldbookRoute.post(
  '/:id/worldbook/compact',
  sValidator('json', compactSchema, validationHook),
  (c) => {
    const body = c.req.valid('json')
    const storyDb = openTrackedStoryDb(c.req.param('id')!)
    try {
      const job = enqueueWorldbookCompactJob(storyDb, c.get('userId'), {
        entryType: body.entryType,
        includeHidden: body.includeHidden,
      })
      return c.json({ ok: true, jobId: job.id })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  },
)
