import { Hono } from 'hono'
import { sValidator } from '@hono/standard-validator'
import { z } from 'zod'
import { validationHook } from '../lib/validation-hook.js'
import { getGlobalDb } from '../db/global-db.js'
import type { AppVariables } from '../middleware/session-guard.js'
import {
  getSettingsSpace,
  saveSettingsSpace,
  revertSettingsSpace,
} from '../db/settings-space-store.js'
import { getSpaceDefault, isKnownSpace } from '../services/settings-space-registry.js'

export const settingsSpacesRoute = new Hono<{ Variables: AppVariables }>()

const spaceParamSchema = z.object({
  space: z.string().refine((s) => isKnownSpace(s), 'unknown settings space'),
})
const putBodySchema = z.object({ value: z.unknown() })

settingsSpacesRoute.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS')
  c.header('Access-Control-Allow-Headers', 'Content-Type')
  if (c.req.method === 'OPTIONS') return c.body(null, 204)
  await next()
})

settingsSpacesRoute.get('/:space', sValidator('param', spaceParamSchema, validationHook), (c) => {
  const { space } = c.req.valid('param')

  const db = getGlobalDb()
  const value = getSettingsSpace(db, c.get('userId'), space, getSpaceDefault(space))
  return c.json({ space, value })
})

settingsSpacesRoute.put(
  '/:space',
  sValidator('param', spaceParamSchema, validationHook),
  sValidator('json', putBodySchema, validationHook),
  async (c) => {
    const { space } = c.req.valid('param')
    const { value } = c.req.valid('json')

    const db = getGlobalDb()
    const saved = saveSettingsSpace(db, c.get('userId'), space, value)
    return c.json({ space, value: saved })
  },
)

settingsSpacesRoute.post(
  '/:space/revert',
  sValidator('param', spaceParamSchema, validationHook),
  (c) => {
    const { space } = c.req.valid('param')

    const db = getGlobalDb()
    const result = revertSettingsSpace(db, c.get('userId'), space)
    if (result === null) return c.json({ error: 'nothing to revert to' }, 409)
    return c.json({ space, value: result })
  },
)
