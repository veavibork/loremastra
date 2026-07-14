import { Hono } from 'hono'
import { sValidator } from '@hono/standard-validator'
import { z } from 'zod'
import { validationHook } from '../../lib/validation-hook.js'
import type { AppVariables } from '../../middleware/session-guard.js'
import { getGlobalDb } from '../../db/global-db.js'
import { getStory } from '../../db/story-store.js'
import { getStoryState } from '../../db/story-state-store.js'
import { forkStory } from '../../services/fork.js'
import { openTrackedStoryDb } from '../../services/story-ops.js'

export const forkRoute = new Hono<{ Variables: AppVariables }>()

const forkSchema = z.object({
  pageId: z.string().optional(),
  name: z.string().optional(),
})

/** Genuinely new save slot — a full copy of the story file, truncated after the fork point. */
forkRoute.post('/:id/fork', sValidator('json', forkSchema, validationHook), async (c) => {
  const body = c.req.valid('json')
  const sourceStoryId = c.req.param('id')!
  const storyDb = openTrackedStoryDb(sourceStoryId)

  if (getStoryState(storyDb).phase !== 'active') {
    return c.json({ error: 'can only fork once the story phase has started' }, 400)
  }

  const globalDb = getGlobalDb()
  const sourceStory = getStory(globalDb, sourceStoryId)
  if (!sourceStory) return c.json({ error: 'source story not found' }, 404)

  try {
    const newStory = forkStory(globalDb, storyDb, {
      ownerUserId: c.get('userId'),
      sourceStoryId,
      sourceName: sourceStory.name,
      name: body.name,
      forkPageId: body.pageId ?? null,
    })
    openTrackedStoryDb(newStory.id)
    return c.json({ story: newStory })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})
