import { Hono } from 'hono'
import type { AppVariables } from '../../middleware/session-guard.js'
import type { GenerationOptions } from '../../services/settings-space-registry.js'
import {
  openTrackedStoryDb,
  postMessage,
  continueStory,
  postSetupMessage,
  kickoffStory,
  startOocSession,
} from '../../services/story-ops.js'

export const messagesRoute = new Hono<{ Variables: AppVariables }>()

messagesRoute.post('/:id/messages', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    content?: string
    generationOptions?: GenerationOptions
  }
  const content = body.content ?? ''
  if (!content.trim()) return c.json({ error: 'content is required' }, 400)

  const storyDb = openTrackedStoryDb(c.req.param('id'))
  const result = postMessage(
    storyDb,
    c.get('userId'),
    c.req.param('id'),
    content,
    body.generationOptions,
  )
  if ('error' in result) return c.json({ error: result.error }, result.status)
  return c.json(result)
})

/**
 * Generate a continuation from the current position (or the head, if nothing's been rewound) —
 * a new agent page, not appended to the existing one. Whether this is an Editor (OOC) or Author
 * (IC) continuation isn't decided by phase alone: post-kickoff, the current position can be a
 * resumed OOC conversation's hidden page just as easily as an in-character one, since both share
 * the same page chain. Checking the attach point's own hidden flag (same invariant as retry, see
 * POST /:id/posts/:pageId/retry) gets this right in both cases.
 */
messagesRoute.post('/:id/continue', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    guidance?: string
    generationOptions?: GenerationOptions
  }
  const storyDb = openTrackedStoryDb(c.req.param('id'))
  const result = continueStory(
    storyDb,
    c.get('userId'),
    c.req.param('id'),
    body.guidance,
    body.generationOptions,
  )
  if ('error' in result) return c.json({ error: result.error }, result.status)
  return c.json(result)
})

/**
 * OOC/setup conversation — usable both before the initial kickoff and any time after (the Story
 * tab's OOC toggle isn't phase-gated, see web/src/StoryView.tsx), e.g. to revise the worldbook
 * without touching the in-character story. Both pages are hidden immediately: it's what lets
 * these turns share the logbook's single page chain with in-character content (advancing the same
 * "head" as everything else) without ever being seen by the Author or shown in Play/IC mode — and
 * what lets buildSetupConversation (dispatch.ts) find just this conversation's own history
 * later, even with a whole IC story now interleaved in between.
 */
messagesRoute.post('/:id/setup/messages', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { content?: string }
  const content = body.content ?? ''
  if (!content.trim()) return c.json({ error: 'content is required' }, 400)

  const storyDb = openTrackedStoryDb(c.req.param('id'))
  const result = postSetupMessage(storyDb, c.get('userId'), c.req.param('id'), content)
  if ('error' in result) return c.json({ error: result.error }, result.status)
  return c.json(result)
})

/**
 * One-shot kickoff: generates the opening post and immediately moves the story into story
 * phase — no separate review/approve step. If the result isn't right, the normal
 * Retry/Guided Retry on this page (via /posts/:pageId/retry) regenerates it; dispatch
 * keys the worldbook-only kickoff prompt off kickoffPageId identity, not current phase, so
 * that keeps working correctly after this point.
 */
messagesRoute.post('/:id/kickoff', (c) => {
  const storyDb = openTrackedStoryDb(c.req.param('id'))
  const result = kickoffStory(storyDb, c.get('userId'), c.req.param('id'))
  if ('error' in result) return c.json({ error: result.error }, result.status)
  return c.json(result)
})

/**
 * Marks a fresh post-kickoff OOC "update session" boundary — every Play→OOC switch after
 * kickoff calls this. No page is created and nothing is added to the log (a canned opener
 * used to be dropped here, but it showed up as a visible chat line and stacked up if someone
 * flipped Play/OOC repeatedly). The boundary is just the most recent existing hidden page, so
 * the Editor's context still resets to this session's turns (plus read-only IC awareness)
 * instead of replaying every OOC turn the story has ever had — silently, with nothing new to
 * see in the log. Pre-kickoff setup doesn't need this — it's already in OOC mode by default
 * from story creation's own canned opener.
 */
messagesRoute.post('/:id/ooc/start-session', (c) => {
  const storyDb = openTrackedStoryDb(c.req.param('id'))
  const result = startOocSession(storyDb)
  if ('error' in result) return c.json({ error: result.error }, result.status)
  return c.json(result)
})
