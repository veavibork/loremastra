import { Hono } from 'hono'
import { sValidator } from '@hono/standard-validator'
import { z } from 'zod'
import { validationHook } from '../lib/validation-hook.js'
import { getGlobalDb } from '../db/global-db.js'
import type { AppVariables } from '../middleware/session-guard.js'
import {
  listModelFormatProfiles,
  getModelFormatProfile,
  requestModelProbe,
  cancelPendingProbe,
} from '../db/model-format-profile-store.js'
import { getProbeProgress, abortRunningProbe } from '../queue/probe-runner.js'

export const modelProfilesRoute = new Hono<{ Variables: AppVariables }>()

// Model ids contain '/' (Qwen/Qwen3-8B), so the API addresses profiles via POST bodies
// rather than path params throughout.
const targetSchema = z.object({
  provider: z.enum(['featherless']),
  model: z.string().min(1),
})

modelProfilesRoute.get('/', (c) => {
  const rows = listModelFormatProfiles(getGlobalDb())
  return c.json({
    profiles: rows.map((row) => ({
      ...row,
      // Live per-condition progress label while the runner has this probe in flight.
      progress: row.status === 'running' ? getProbeProgress(row.provider, row.modelId) : null,
    })),
  })
})

/** Enqueue a probe (or re-probe). No-op if one is already pending/running for this model. */
modelProfilesRoute.post('/probe', sValidator('json', targetSchema, validationHook), (c) => {
  const { provider, model } = c.req.valid('json')
  const row = requestModelProbe(getGlobalDb(), provider, model.trim(), c.get('userId'))
  return c.json({ profile: { ...row, progress: null } })
})

modelProfilesRoute.post('/cancel', sValidator('json', targetSchema, validationHook), (c) => {
  const { provider, model } = c.req.valid('json')
  const db = getGlobalDb()
  const row = getModelFormatProfile(db, provider, model)
  if (!row) return c.json({ error: 'no probe found for this model' }, 404)
  if (row.status === 'pending') {
    cancelPendingProbe(db, provider, model)
    return c.json({ ok: true })
  }
  if (row.status === 'running') {
    // The runner's abort handler writes the cancelled status and frees the slot.
    if (abortRunningProbe(provider, model)) return c.json({ ok: true })
    // Running row but no live probe in this process (stale from a crash) — recoverStaleProbes
    // handles it at next boot; report honestly rather than pretending we stopped something.
    return c.json({ error: 'probe is marked running but has no live process to abort' }, 409)
  }
  return c.json({ error: `probe is already ${row.status}` }, 409)
})
