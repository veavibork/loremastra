import bcrypt from 'bcryptjs'
import { Hono } from 'hono'
import { sValidator } from '@hono/standard-validator'
import { z } from 'zod'
import { validationHook } from '../lib/validation-hook.js'
import { getGlobalDb } from '../db/global-db.js'
import {
  DisplayNameTakenError,
  getMaskedKeys,
  getUserById,
  setFeatherlessKey,
  setHordeKey,
  updateDisplayName,
  updatePassword,
} from '../db/user-store.js'
import type { AppVariables } from '../middleware/session-guard.js'

export const accountRoute = new Hono<{ Variables: AppVariables }>()

const displayNameSchema = z.object({ displayName: z.string().min(1) })
const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
})
const keySchema = z.object({ key: z.string().min(1) })

// Every handler below trusts only c.get("userId") (set by sessionGuard from the caller's own
// session), never a userId in the request body — otherwise any authenticated caller could edit
// someone else's account by naming their id in the payload.

accountRoute.get('/', (c) => {
  const db = getGlobalDb()
  const user = getUserById(db, c.get('userId'))
  if (!user) return c.json({ error: 'user not found' }, 404)
  return c.json({ id: user.id, displayName: user.displayName, ...getMaskedKeys(db, user.id) })
})

accountRoute.patch(
  '/display-name',
  sValidator('json', displayNameSchema, validationHook),
  async (c) => {
    const { displayName } = c.req.valid('json')

    const db = getGlobalDb()
    try {
      const user = updateDisplayName(db, c.get('userId'), displayName)
      return c.json({ id: user.id, displayName: user.displayName })
    } catch (err) {
      if (err instanceof DisplayNameTakenError) {
        return c.json({ error: err.message }, 409)
      }
      throw err
    }
  },
)

accountRoute.post('/password', sValidator('json', passwordSchema, validationHook), async (c) => {
  const { currentPassword, newPassword } = c.req.valid('json')

  const db = getGlobalDb()
  const user = getUserById(db, c.get('userId'))
  if (!user || !bcrypt.compareSync(currentPassword, user.passwordVerifier)) {
    return c.json({ error: 'current password is incorrect' }, 401)
  }

  updatePassword(db, user.id, bcrypt.hashSync(newPassword, 10))
  return c.json({ ok: true })
})

accountRoute.put('/featherless-key', sValidator('json', keySchema, validationHook), async (c) => {
  const { key } = c.req.valid('json')

  const db = getGlobalDb()
  setFeatherlessKey(db, c.get('userId'), key)
  return c.json(getMaskedKeys(db, c.get('userId')))
})

accountRoute.delete('/featherless-key', (c) => {
  const db = getGlobalDb()
  setFeatherlessKey(db, c.get('userId'), null)
  return c.json(getMaskedKeys(db, c.get('userId')))
})

accountRoute.put('/horde-key', sValidator('json', keySchema, validationHook), async (c) => {
  const { key } = c.req.valid('json')

  const db = getGlobalDb()
  setHordeKey(db, c.get('userId'), key)
  return c.json(getMaskedKeys(db, c.get('userId')))
})

accountRoute.delete('/horde-key', (c) => {
  const db = getGlobalDb()
  setHordeKey(db, c.get('userId'), null)
  return c.json(getMaskedKeys(db, c.get('userId')))
})
