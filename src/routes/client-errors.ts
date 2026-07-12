import { Hono } from 'hono'
import { getGlobalDb } from '../db/global-db.js'
import { createClientError, listClientErrors } from '../db/client-error-store.js'

const VALID_SEVERITIES = new Set(['info', 'warning', 'error', 'critical'])

export const clientErrorsRoute = new Hono()

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

clientErrorsRoute.post('/', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    severity?: string
    message?: string
    url?: string
    userAgent?: string
  }
  if (!body.severity || !VALID_SEVERITIES.has(body.severity)) {
    return c.json({ error: 'severity must be one of info|warning|error|critical' }, 400)
  }
  if (!body.message || !body.message.trim()) {
    return c.json({ error: 'message is required' }, 400)
  }

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
  const limit = limitParam ? Number(limitParam) : undefined
  const db = getGlobalDb()
  return c.json({ errors: listClientErrors(db, { limit }) })
})
