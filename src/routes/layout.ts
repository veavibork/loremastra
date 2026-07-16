import { Hono } from 'hono'
import { sValidator } from '@hono/standard-validator'
import { z } from 'zod'
import { validationHook } from '../lib/validation-hook.js'
import { getGlobalDb } from '../db/global-db.js'
import type { AppVariables } from '../middleware/session-guard.js'
import {
  createLayoutConfig,
  getActiveLayoutConfig,
  listLayoutConfigs,
  updateLayoutConfigJson,
  setActiveLayoutConfig,
} from '../db/layout-config-store.js'
import { DEFAULT_LAYOUT_CONFIG, normalizeLayoutConfig } from '../services/layout.js'

export const layoutRoute = new Hono<{ Variables: AppVariables }>()

const patchSchema = z.object({
  config: z.unknown(),
  name: z.string().optional(),
})

/** The active layout config, or the built-in default if the user has never saved one. */
layoutRoute.get('/', (c) => {
  const db = getGlobalDb()
  const active = getActiveLayoutConfig(db, c.get('userId'))
  if (active) {
    const config = normalizeLayoutConfig(JSON.parse(active.configJson))
    return c.json({ id: active.id, name: active.name, config })
  }
  return c.json({ id: null, name: 'Default', config: DEFAULT_LAYOUT_CONFIG })
})

layoutRoute.get('/all', (c) => {
  const db = getGlobalDb()
  return c.json({ configs: listLayoutConfigs(db, c.get('userId')) })
})

/** Edits the active config in place, or creates+activates a new one if none exists yet. */
layoutRoute.patch('/', sValidator('json', patchSchema, validationHook), async (c) => {
  const { config: raw, name } = c.req.valid('json')

  const db = getGlobalDb()
  const userId = c.get('userId')
  const config = normalizeLayoutConfig(raw)
  const configJson = JSON.stringify(config)

  const active = getActiveLayoutConfig(db, userId)
  const saved = active
    ? updateLayoutConfigJson(db, active.id, configJson)
    : createLayoutConfig(db, {
        userId,
        name: name?.trim() || 'Default',
        configJson,
        isActive: true,
      })

  return c.json({ id: saved.id, name: saved.name, config: JSON.parse(saved.configJson) })
})

layoutRoute.post('/:id/activate', (c) => {
  const db = getGlobalDb()
  const ok = setActiveLayoutConfig(db, c.get('userId'), c.req.param('id'))
  if (!ok) return c.json({ error: 'layout config not found' }, 404)
  return c.json({ ok: true })
})
