import bcrypt from 'bcryptjs'
import { Hono } from 'hono'
import { sValidator } from '@hono/standard-validator'
import { z } from 'zod'
import { validationHook } from '../lib/validation-hook.js'
import { getGlobalDb } from '../db/global-db.js'
import { getUserById } from '../db/user-store.js'
import { createSession } from '../db/session-store.js'

export const sessionsRoute = new Hono()

const claimSchema = z.object({
  userId: z.string().min(1),
  password: z.string().min(1),
})

// Deliberately exempt from src/middleware/session-guard.ts (chicken-and-egg: nothing has
// a session id to present until this call returns one). The guard skips this exact path.
sessionsRoute.post('/claim', sValidator('json', claimSchema, validationHook), async (c) => {
  const { userId, password } = c.req.valid('json')

  const db = getGlobalDb()
  const user = getUserById(db, userId)
  if (!user || !bcrypt.compareSync(password, user.passwordVerifier)) {
    return c.json({ error: 'invalid credentials' }, 401)
  }

  const session = createSession(db, user.id)
  return c.json({ sessionId: session.id, claimedAt: session.createdAt })
})
