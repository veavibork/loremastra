import { Hono } from 'hono'
import { sValidator } from '@hono/standard-validator'
import { z } from 'zod'
import { validationHook } from '../lib/validation-hook.js'
import { getGlobalDb } from '../db/global-db.js'
import { createClientError, listClientErrors } from '../db/client-error-store.js'

export const clientErrorsRoute = new Hono()

const createErrorSchema = z.object({
  severity: z.enum(['info', 'warning', 'error', 'critical']),
  message: z.string().min(1),
  url: z.string().optional(),
  userAgent: z.string().optional(),
})

clientErrorsRoute.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  c.header(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Loremaster-Session, X-Loremaster-Interaction',
  )
  if (c.req.method === 'OPTIONS') return c.body(null, 204)
  await next()
})

clientErrorsRoute.post('/', sValidator('json', createErrorSchema, validationHook), async (c) => {
  const body = c.req.valid('json')

  const db = getGlobalDb()
  const created = createClientError(db, {
    severity: body.severity,
    message: body.message,
    url: body.url,
    userAgent: body.userAgent,
  })
  return c.json({ clientError: created })
})

clientErrorsRoute.get('/', (c) => {
  const limitParam = c.req.query('limit')
  const parsed = limitParam ? Number(limitParam) : NaN
  // listClientErrors defaults to 200 when no limit is given — mirror that default here for
  // any missing/malformed value (e.g. `?limit=abc`) instead of letting NaN reach the DB layer,
  // where better-sqlite3 throws a "datatype mismatch" binding it to LIMIT.
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
  const db = getGlobalDb()
  return c.json({ errors: listClientErrors(db, { limit }) })
})
