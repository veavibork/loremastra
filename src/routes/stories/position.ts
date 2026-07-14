import { Hono } from 'hono'
import { sValidator } from '@hono/standard-validator'
import { z } from 'zod'
import { validationHook } from '../../lib/validation-hook.js'
import type { AppVariables } from '../../middleware/session-guard.js'
import { getBookByType } from '../../db/book-store.js'
import { findHeadPageId, collectAncestorIds } from '../../db/page-store.js'
import { getStoryState, setCurrentPageId } from '../../db/story-state-store.js'
import { recordHistoryEvent, undoHistory, redoHistory } from '../../db/history-store.js'
import { onCanonicalTextChangedForStory } from '../../services/context/invalidation.js'
import { openTrackedStoryDb, currentPosition } from '../../services/story-ops.js'

export const positionRoute = new Hono<{ Variables: AppVariables }>()

const rewindSchema = z.object({
  pageId: z.string(),
})

/** Where the "cursor" is right now — the head unless Undo/Redo/Rewind has moved it. See loremaster.md's Post Controls: Undo/Redo. */
positionRoute.get('/:id/position', (c) => {
  const storyDb = openTrackedStoryDb(c.req.param('id')!)
  const logbook = getBookByType(storyDb, 'logbook')
  if (!logbook) return c.json({ error: 'logbook not found' }, 404)
  return c.json(currentPosition(storyDb))
})

/** Reverses whatever happened most recently on the unified history ledger — navigation, retry, or edit. See history-store.ts. */
positionRoute.post('/:id/position/undo', (c) => {
  const storyDb = openTrackedStoryDb(c.req.param('id')!)
  const result = undoHistory(storyDb)
  if (!result) return c.json({ error: 'already at the beginning' }, 400)
  if (result.canonicalTextPageId) {
    onCanonicalTextChangedForStory(
      storyDb,
      c.get('userId'),
      c.req.param('id')!,
      result.canonicalTextPageId,
    )
  }
  return c.json(currentPosition(storyDb))
})

positionRoute.post('/:id/position/redo', (c) => {
  const storyDb = openTrackedStoryDb(c.req.param('id')!)
  const result = redoHistory(storyDb)
  if (!result) return c.json({ error: 'nothing to redo' }, 400)
  if (result.canonicalTextPageId) {
    onCanonicalTextChangedForStory(
      storyDb,
      c.get('userId'),
      c.req.param('id')!,
      result.canonicalTextPageId,
    )
  }
  return c.json(currentPosition(storyDb))
})

/** Rewind directly to any page in the current head's history (not just one step) — same underlying cursor as Undo/Redo, just a bigger jump. */
positionRoute.post('/:id/position', sValidator('json', rewindSchema, validationHook), (c) => {
  const { pageId } = c.req.valid('json')
  const storyDb = openTrackedStoryDb(c.req.param('id')!)
  const logbook = getBookByType(storyDb, 'logbook')
  if (!logbook) return c.json({ error: 'logbook not found' }, 404)

  const headPageId = findHeadPageId(storyDb, logbook.id)
  if (!headPageId) return c.json({ error: 'story has no posts yet' }, 400)

  const ancestry = collectAncestorIds(storyDb, headPageId)
  if (!ancestry.has(pageId)) {
    return c.json({ error: "that page isn't part of the current story's history" }, 400)
  }

  const fromPageId = getStoryState(storyDb).currentPageId ?? headPageId
  setCurrentPageId(storyDb, pageId === headPageId ? null : pageId)
  recordHistoryEvent(storyDb, {
    kind: 'page',
    pageId,
    fromValue: fromPageId,
    toValue: pageId,
  })
  return c.json(currentPosition(storyDb))
})
