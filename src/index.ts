import { logUnhandledError } from './lib/errors.js'
import { startHealthSnapshots, type HealthSnapshot } from './lib/pipeline-health.js'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { storiesRoute } from './routes/stories.js'
import { layoutRoute } from './routes/layout.js'
import { agentsRoute } from './routes/agents.js'
import { promptsRoute } from './routes/prompts.js'
import { settingsSpacesRoute } from './routes/settings-spaces.js'
import { clientErrorsRoute } from './routes/client-errors.js'
import { sessionsRoute } from './routes/sessions.js'
import { accountRoute } from './routes/account.js'
import { preferenceProfilesRoute } from './routes/preference-profiles.js'
import { sessionGuard, type AppVariables } from './middleware/session-guard.js'
import { startPipelineRunner, trackStoryDb, getTrackedJobCounts } from './queue/dispatch.js'
import { getQueueStatus } from './queue/slots.js'
import { getGlobalDb } from './db/global-db.js'
import { listAllStories } from './db/story-store.js'
import { getStoryDb } from './db/story-db.js'
import { listUsers } from './db/user-store.js'

const app = new Hono<{ Variables: AppVariables }>()
// The only middleware that actually answers a browser's CORS preflight: it short-circuits
// OPTIONS before dispatch reaches any sub-route's own "*" middleware (app.route() delegates
// to those only for non-preflight handling), so their per-route Allow-Methods headers are
// dead code for OPTIONS specifically. This one has to list every method any route uses.
app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  c.header(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Loremaster-Session, X-Loremaster-Interaction',
  )
  if (c.req.method === 'OPTIONS') return c.body(null, 204)
  await next()
})
// Single-active-session enforcement (src/middleware/session-guard.ts) — must run after the
// CORS middleware above (so OPTIONS preflight is never blocked) and before every route,
// including the two inline ones below, so nothing is exempt by omission.
app.use('*', sessionGuard)
app.route('/api/sessions', sessionsRoute)
app.route('/api/account', accountRoute)
app.route('/api/stories', storiesRoute)
app.route('/api/layout', layoutRoute)
app.route('/api/agents', agentsRoute)
app.route('/api/prompts', promptsRoute)
app.route('/api/settings', settingsSpacesRoute)
app.route('/api/client-errors', clientErrorsRoute)
app.route('/api/preference-profiles', preferenceProfilesRoute)
app.get('/api/debug/slots', (c) => c.json(getQueueStatus(c.get('userId'))))
// Exempt from session-guard (GET only) — the profile picker needs this before any session exists.
app.get('/api/users', (c) => c.json(listUsers(getGlobalDb())))

const port = Number(process.env.PORT ?? 4113)

/**
 * The pipeline runner only scans stories it's tracking (src/queue/dispatch.ts), which
 * previously only happened once an HTTP request touched that story this process lifetime — so
 * any story not reopened in the browser after a restart had its pending/running jobs sit frozen
 * indefinitely, even though nothing was actually wrong with them. Tracking every story at boot
 * closes that gap; cheap at this project's current scale (a handful of stories, single default
 * user — see docs/roadmap.md's Phase 2 backlog). Best-effort per story so one corrupt/missing
 * story file can't block the rest from being tracked or take down startup.
 */
function trackAllStoriesAtStartup(): void {
  const db = getGlobalDb()
  for (const story of listAllStories(db)) {
    try {
      trackStoryDb(story.id, getStoryDb(story.id))
    } catch (err) {
      console.error(
        `failed to track story ${story.id} at startup:`,
        err instanceof Error ? err.message : err,
      )
    }
  }
}

trackAllStoriesAtStartup()
startPipelineRunner()
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Loremaster listening on http://localhost:${info.port}`)
})

// -- Global error handlers --

process.on('unhandledRejection', (reason) => {
  logUnhandledError({ source: 'unhandledRejection' }, reason)
})

process.on('uncaughtException', (err) => {
  logUnhandledError({ source: 'uncaughtException' }, err)
  // Don't exit — the pipeline runner is the critical subsystem and a single
  // story/slot error shouldn't take down the whole HTTP server.
})

// -- Pipeline health snapshots --

function buildHealthSnapshot(): Omit<HealthSnapshot, 'at'> {
  const db = getGlobalDb()
  const users = listUsers(db)
  const userId = users[0]?.id ?? ''
  const queue = getQueueStatus(userId)
  const { activeJobs, pendingJobs, hordeJobsRunning } = getTrackedJobCounts()
  return {
    activeJobs,
    pendingJobs,
    slotsUsed: queue.used,
    slotsMax: queue.max,
    hordeJobsRunning,
    trackedStories: listAllStories(db).length,
  }
}

startHealthSnapshots(buildHealthSnapshot)
