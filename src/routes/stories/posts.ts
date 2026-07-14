import { Hono } from 'hono'
import { sValidator } from '@hono/standard-validator'
import { z } from 'zod'
import { validationHook } from '../../lib/validation-hook.js'
import type { AppVariables } from '../../middleware/session-guard.js'
import { openTrackedStoryDb, retryPost, editPost } from '../../services/story-ops.js'

export const postsRoute = new Hono<{ Variables: AppVariables }>()

const retrySchema = z.object({
  guidance: z.string().optional(),
  generationOptions: z.any().optional(),
})

const editPostSchema = z.object({
  content: z.string().optional(),
})

/**
 * Regenerate an existing agent post in place — a new text version on the same page, per
 * loremaster.md's Retry / Guided retry. Works on any agent page regardless of phase (the
 * setup conversation and story posts share the same logbook), but which *job type* to queue
 * depends on what kind of page it is: an OOC/setup page needs the Editor's tool-calling turn
 * (executeSetupJob), not a plain prose continuation — retrying it as "prose" would run it
 * through the Author's core prompt instead of the setup flow entirely. Every OOC/setup page is
 * hidden the moment it's created (see POST /:id/setup/messages) and no other page ever is, so
 * page.hidden is a direct, phase-independent answer — including for a page created by a resumed
 * post-kickoff OOC conversation, which isn't an ancestor of kickoffPageId the way a pre-kickoff
 * setup page is.
 */
postsRoute.post(
  '/:id/posts/:pageId/retry',
  sValidator('json', retrySchema, validationHook),
  (c) => {
    const body = c.req.valid('json')
    const storyDb = openTrackedStoryDb(c.req.param('id')!)
    const result = retryPost(
      storyDb,
      c.get('userId'),
      c.req.param('id')!,
      c.req.param('pageId')!,
      body.guidance,
      body.generationOptions,
    )
    if ('error' in result) return c.json({ error: result.error }, result.status)
    return c.json(result)
  },
)

/** Directly overwrite a post's content — a new text version with user-supplied text, no inference call. Re-indexed against tags immediately. */
postsRoute.post(
  '/:id/posts/:pageId/edit',
  sValidator('json', editPostSchema, validationHook),
  (c) => {
    const body = c.req.valid('json')
    const content = body.content ?? ''
    if (!content.trim()) return c.json({ error: 'content is required' }, 400)

    const storyDb = openTrackedStoryDb(c.req.param('id')!)
    const result = editPost(
      storyDb,
      c.get('userId'),
      c.req.param('id')!,
      c.req.param('pageId')!,
      content,
    )
    if ('error' in result) return c.json({ error: result.error }, result.status)
    return c.json({ ok: true, ...result })
  },
)
