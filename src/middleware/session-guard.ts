import type { Context, Next } from 'hono'
import { getGlobalDb } from '../db/global-db.js'
import { getActiveSession, getSession, touchSession } from '../db/session-store.js'

export type AppVariables = { userId: string }

try {
  process.loadEnvFile()
} catch {
  // no .env present; rely on process.env as-is
}

const CLAIM_PATH = '/api/sessions/claim'
const USERS_PATH = '/api/users'

// Dev-only escape hatch (2026-07-03) — during a stretch of active development this guard's
// "no bypass, covers all HTTP access" design (see below) means every curl/dev script needs a
// real, eviction-causing session claim just to hit a route. Explicit opt-in via .env, logged
// loudly on every request so it's never silently forgotten on. Turn it back off (unset the
// var, restart) once active dev work settles down — see project_loremaster_dev_workflow_notes
// memory for the reasoning.
const BYPASS_SESSION_GUARD = process.env.DEV_BYPASS_SESSION_GUARD === 'true'
if (BYPASS_SESSION_GUARD) {
  console.warn(
    '[session-guard] DEV_BYPASS_SESSION_GUARD is set — session enforcement is OFF for all requests.',
  )
}

/**
 * Global single-active-session enforcement (loremaster.md's Security section — this is
 * the "single-active-session eviction" piece on its own, without the password/login step
 * it originally assumed). Not access control: anyone can still call this API with zero
 * credentials, same as before. It only arbitrates between one trusted user's own
 * devices/tabs, and — per explicit product decision — deliberately covers *all* HTTP
 * access including raw curl/dev scripts, not just the browser, so there's no bypass to
 * remember to use *in normal operation*. Direct in-process DB/script access (no HTTP
 * involved) is outside what this can see at all — see docs/stub-revisions.md for that
 * accepted limitation. DEV_BYPASS_SESSION_GUARD (above) is the one deliberate, opt-in
 * exception to "no bypass," for active-development stretches only.
 */
export async function sessionGuard(
  c: Context<{ Variables: AppVariables }>,
  next: Next,
): Promise<Response | void> {
  if (c.req.method === 'OPTIONS') return next()
  if (c.req.method === 'POST' && c.req.path === CLAIM_PATH) return next()
  if (c.req.method === 'GET' && c.req.path === USERS_PATH) return next()

  const db = getGlobalDb()

  if (BYPASS_SESSION_GUARD) {
    // Dev escape hatch still needs *some* userId downstream — fall back to whichever user
    // happens to be oldest, same stand-in the old single-default-user model used.
    const fallback = db.prepare(`SELECT id FROM users ORDER BY created_at ASC LIMIT 1`).get() as
      { id: string } | undefined
    if (fallback) c.set('userId', fallback.id)
    return next()
  }

  const sessionId = c.req.header('X-Loremaster-Session') ?? c.req.query('session')

  if (!sessionId) {
    return c.json({ error: 'unclaimed' }, 409)
  }

  const session = getSession(db, sessionId)

  if (!session || session.revokedAt) {
    const active = session ? getActiveSession(db, session.userId) : null
    return c.json(
      {
        error: 'superseded',
        active: active ? { lastSeenAt: active.lastSeenAt } : null,
        stale: session ? { lastSeenAt: session.lastSeenAt } : null,
      },
      409,
    )
  }

  if (c.req.header('X-Loremaster-Interaction') !== 'background') {
    touchSession(db, session.id)
  }
  c.set('userId', session.userId)
  return next()
}
