import { Hono } from 'hono'
import type { AppVariables } from '../../middleware/session-guard.js'
import { getBookByType } from '../../db/book-store.js'
import {
  createWorldbookEntry,
  listWorldbookEntries,
  updateWorldbookEntry,
  setWorldbookEntryHidden,
  type WorldbookEntryType,
} from '../../db/worldbook-store.js'
import { enqueueWorldbookCompactJob } from '../../services/worldbook/compact.js'
import { openTrackedStoryDb } from '../../services/story-ops.js'

export const worldbookRoute = new Hono<{ Variables: AppVariables }>()

worldbookRoute.get('/:id/worldbook', (c) => {
  const storyDb = openTrackedStoryDb(c.req.param('id'))
  const worldbook = getBookByType(storyDb, 'worldbook')
  if (!worldbook) return c.json({ error: 'worldbook not found' }, 404)
  return c.json({ entries: listWorldbookEntries(storyDb, worldbook.id, { includeHidden: true }) })
})

worldbookRoute.post('/:id/worldbook', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    entryType?: WorldbookEntryType
    content?: string
  }
  if (!body.entryType || !body.content?.trim())
    return c.json({ error: 'entryType and content are required' }, 400)

  const storyDb = openTrackedStoryDb(c.req.param('id'))
  const worldbook = getBookByType(storyDb, 'worldbook')
  if (!worldbook) return c.json({ error: 'worldbook not found' }, 404)

  try {
    const entry = createWorldbookEntry(storyDb, {
      bookId: worldbook.id,
      entryType: body.entryType,
      content: body.content,
    })
    return c.json({ entry })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

worldbookRoute.patch('/:id/worldbook/:pageId', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { content?: string; hidden?: boolean }
  const storyDb = openTrackedStoryDb(c.req.param('id'))
  const pageId = c.req.param('pageId')

  try {
    if (typeof body.hidden === 'boolean') setWorldbookEntryHidden(storyDb, pageId, body.hidden)
    if (typeof body.content === 'string') {
      updateWorldbookEntry(storyDb, pageId, { content: body.content })
    }
    return c.json({ ok: true })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

/** Manual worldbook compaction — queued on the worker lane; shows in Logs → Queue. */
worldbookRoute.post('/:id/worldbook/compact', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    entryType?: WorldbookEntryType
    includeHidden?: boolean
  }
  const storyDb = openTrackedStoryDb(c.req.param('id'))
  try {
    const job = enqueueWorldbookCompactJob(storyDb, c.get('userId'), {
      entryType: body.entryType,
      includeHidden: body.includeHidden,
    })
    return c.json({ ok: true, jobId: job.id })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})
