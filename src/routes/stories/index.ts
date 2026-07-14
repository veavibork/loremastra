import { Hono, type Context, type Next } from 'hono'
import type { AppVariables } from '../../middleware/session-guard.js'
import { getGlobalDb } from '../../db/global-db.js'
import { listStories, getStory, renameStory } from '../../db/story-store.js'
import { getStoryStats } from '../../services/story-stats.js'
import { getBookByType } from '../../db/book-store.js'
import { findHeadPageId } from '../../db/page-store.js'
import { getStoryState } from '../../db/story-state-store.js'
import { resolveIcStartPageId } from '../../services/story-transition.js'
import { STORY_TO_DATE_TRIGGER } from '../../services/story-to-date/index.js'
import { getAgentProfile } from '../../services/agent-config.js'
import { buildLogView } from '../../services/log-view.js'
import { buildPromptPreview } from '../../services/prompt-preview.js'
import { cachedStoryRead } from '../../services/story-read-cache.js'
import {
  openTrackedStoryDb,
  createStoryWithBooks,
  deleteStoryWithFiles,
} from '../../services/story-ops.js'
import { forkRoute } from './fork.js'
import { postsRoute } from './posts.js'
import { positionRoute } from './position.js'
import { messagesRoute } from './messages.js'
import { worldbookRoute } from './worldbook.js'
import { jobsRoute } from './jobs.js'
import { segmentsRoute } from './segments.js'
import { contextRoute } from './context.js'

const STORY_READ_CACHE_TTL_MS = 2000

export const storiesRoute = new Hono<{ Variables: AppVariables }>()

storiesRoute.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  c.header('Access-Control-Allow-Headers', 'Content-Type')
  if (c.req.method === 'OPTIONS') return c.body(null, 204)
  await next()
})

/**
 * Every route below the top-level POST/GET "/" operates on a specific story by id — this
 * enforces that the requesting user actually owns it, once for all of them, rather than
 * repeating the check in ~25 individual handlers.
 */
async function requireStoryOwnership(
  c: Context<{ Variables: AppVariables }>,
  next: Next,
): Promise<Response | void> {
  const story = getStory(getGlobalDb(), c.req.param('id')!)
  if (!story) return c.json({ error: 'story not found' }, 404)
  if (story.ownerUserId !== c.get('userId')) return c.json({ error: 'forbidden' }, 403)
  await next()
}
storiesRoute.use('/:id', requireStoryOwnership)
storiesRoute.use('/:id/*', requireStoryOwnership)

// --- CRUD (no :id param on create/list) ---

storiesRoute.post('/', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string }
  const { story } = createStoryWithBooks(c.get('userId'), body.name)
  return c.json({ story })
})

storiesRoute.get('/', (c) => {
  const globalDb = getGlobalDb()
  const stories = listStories(globalDb, c.get('userId')).map((story) => ({
    ...story,
    stats: getStoryStats(openTrackedStoryDb(story.id)),
  }))
  return c.json({ stories })
})

storiesRoute.patch('/:id', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string }
  const globalDb = getGlobalDb()
  const id = c.req.param('id')
  if (!getStory(globalDb, id)) return c.json({ error: 'story not found' }, 404)

  if (typeof body.name === 'string' && body.name.trim()) {
    renameStory(globalDb, id, body.name.trim())
  }
  return c.json({ story: getStory(globalDb, id) })
})

storiesRoute.delete('/:id', async (c) => {
  await deleteStoryWithFiles(c.req.param('id'))
  return c.json({ ok: true })
})

// --- Log + prompt-preview + phase ---

storiesRoute.get('/:id/log', async (c) => {
  const storyId = c.req.param('id')
  const storyDb = openTrackedStoryDb(storyId)
  const logbook = getBookByType(storyDb, 'logbook')
  if (!logbook) return c.json({ error: 'logbook not found' }, 404)

  const limitParam = Number(c.req.query('limit'))
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.floor(limitParam) : undefined
  const beforePageId = c.req.query('beforePageId') || undefined
  const throughPageId = c.req.query('throughPageId') || undefined
  const cacheKey = `${storyId}:log:${limit ?? ''}:${beforePageId ?? ''}:${throughPageId ?? ''}`

  const page = await cachedStoryRead(cacheKey, STORY_READ_CACHE_TTL_MS, () =>
    buildLogView(storyDb, logbook.id, { limit, beforePageId, throughPageId }),
  )
  return c.json(page)
})

/**
 * The assembled Author prompt at the current position — read-only, no inference call.
 */
storiesRoute.get('/:id/prompt-preview', async (c) => {
  const storyId = c.req.param('id')
  const userId = c.get('userId')
  const storyDb = openTrackedStoryDb(storyId)
  const logbook = getBookByType(storyDb, 'logbook')
  if (!logbook) return c.json({ error: 'logbook not found' }, 404)

  const currentPageId = getStoryState(storyDb).currentPageId ?? findHeadPageId(storyDb, logbook.id)
  if (!currentPageId) {
    const author = getAgentProfile(userId, 'author')
    const usableBudget = author.contextLimit - author.responseLimit
    return c.json({
      messages: [],
      totalTokens: 0,
      usableBudget,
      storyToDateTriggerAt: Math.floor(usableBudget * STORY_TO_DATE_TRIGGER),
    })
  }

  const cacheKey = `${storyId}:prompt-preview:${userId}:${currentPageId}`
  const preview = await cachedStoryRead(cacheKey, STORY_READ_CACHE_TTL_MS, () =>
    buildPromptPreview(storyDb, userId, logbook.id, currentPageId),
  )
  return c.json(preview)
})

storiesRoute.get('/:id/phase', (c) => {
  const storyDb = openTrackedStoryDb(c.req.param('id'))
  const state = getStoryState(storyDb)
  const logbook = getBookByType(storyDb, 'logbook')
  return c.json({
    ...state,
    kickoffPageId: logbook ? resolveIcStartPageId(storyDb, logbook.id) : null,
  })
})

// --- Mount sub-apps ---

storiesRoute.route('/', forkRoute)
storiesRoute.route('/', postsRoute)
storiesRoute.route('/', positionRoute)
storiesRoute.route('/', messagesRoute)
storiesRoute.route('/', worldbookRoute)
storiesRoute.route('/', jobsRoute)
storiesRoute.route('/', segmentsRoute)
storiesRoute.route('/', contextRoute)
