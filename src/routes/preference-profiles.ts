import { Hono } from 'hono'
import { sValidator } from '@hono/standard-validator'
import { z } from 'zod'
import { validationHook } from '../lib/validation-hook.js'
import { getGlobalDb } from '../db/global-db.js'
import type { AppVariables } from '../middleware/session-guard.js'
import {
  listPreferenceProfiles,
  getPreferenceProfile,
  createPreferenceProfile,
  updatePreferenceProfile,
  setActivePreferenceProfile,
  deletePreferenceProfile,
} from '../db/preference-profile-store.js'

export const preferenceProfilesRoute = new Hono<{ Variables: AppVariables }>()

const createSchema = z.object({
  name: z.string().min(1),
  settings: z.record(z.string(), z.unknown()),
})

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
})

preferenceProfilesRoute.get('/', (c) => {
  const db = getGlobalDb()
  return c.json({ profiles: listPreferenceProfiles(db, c.get('userId')) })
})

preferenceProfilesRoute.post('/', sValidator('json', createSchema, validationHook), (c) => {
  const { name, settings } = c.req.valid('json')
  const db = getGlobalDb()
  const profile = createPreferenceProfile(db, c.get('userId'), { name, settings })
  return c.json({ profile }, 201)
})

preferenceProfilesRoute.get('/:id', (c) => {
  const db = getGlobalDb()
  const profile = getPreferenceProfile(db, c.req.param('id')!, c.get('userId'))
  if (!profile) return c.json({ error: 'profile not found' }, 404)
  return c.json({ profile })
})

preferenceProfilesRoute.patch('/:id', sValidator('json', updateSchema, validationHook), (c) => {
  const body = c.req.valid('json')
  const db = getGlobalDb()
  const profile = updatePreferenceProfile(db, c.req.param('id')!, c.get('userId'), body)
  if (!profile) return c.json({ error: 'profile not found' }, 404)
  return c.json({ profile })
})

preferenceProfilesRoute.post('/:id/activate', (c) => {
  const db = getGlobalDb()
  const profile = setActivePreferenceProfile(db, c.req.param('id')!, c.get('userId'))
  if (!profile) return c.json({ error: 'profile not found' }, 404)
  return c.json({ profile })
})

preferenceProfilesRoute.delete('/:id', (c) => {
  const db = getGlobalDb()
  const deleted = deletePreferenceProfile(db, c.req.param('id')!, c.get('userId'))
  if (!deleted) return c.json({ error: 'profile not found' }, 404)
  return c.json({ ok: true })
})
