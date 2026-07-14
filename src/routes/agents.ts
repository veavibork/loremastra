import { Hono, type Context } from 'hono'
import { sValidator } from '@hono/standard-validator'
import { z } from 'zod'
import { validationHook } from '../lib/validation-hook.js'
import { getGlobalDb } from '../db/global-db.js'
import type { AppVariables } from '../middleware/session-guard.js'
import {
  listModelConfigs,
  createModelConfig,
  updateModelConfig,
  deleteModelConfig,
  reorderModelConfigs,
  type ModelConfigInput,
} from '../db/model-config-store.js'
import { getAgentProfile } from '../services/agent-config.js'
import { listModels, getModel } from '../inference/featherless-models.js'
import { getHfTagsForModel } from '../inference/hf-model-tags.js'
import { listTextModels } from '../inference/horde.js'
import { getDecryptedFeatherlessKey, getDecryptedHordeKey } from '../db/user-store.js'

export const agentsRoute = new Hono<{ Variables: AppVariables }>()

export interface CatalogModel {
  id: string
  contextLength?: number
  concurrencyCost?: number
  toolUse?: boolean
  hfTags?: string[]
}

// Provider-dispatching model catalog lookup, used by Config > Agents' "Fetch models" action.
agentsRoute.get('/models', async (c) => {
  const provider = c.req.query('provider') ?? 'featherless'
  const db = getGlobalDb()
  const userId = c.get('userId')
  if (provider === 'featherless') {
    const apiKey = getDecryptedFeatherlessKey(db, userId)
    if (!apiKey)
      return c.json({ error: 'No Featherless API key configured — set one in the Agents tab' }, 400)
    const models = await listModels(apiKey, { perPage: 200 })
    const configs = listModelConfigs(db, userId).filter((c) => c.provider === 'featherless')
    for (const m of models) {
      if (m.concurrencyCost == null) continue
      for (const cfg of configs.filter(
        (c) => c.model === m.id && c.concurrencyCost !== m.concurrencyCost,
      )) {
        updateModelConfig(db, cfg.id, { concurrencyCost: m.concurrencyCost })
      }
    }
    const catalog: CatalogModel[] = models.map((m) => ({
      id: m.id,
      contextLength: m.contextLength,
      concurrencyCost: m.concurrencyCost,
      toolUse: m.toolUse,
      hfTags: getHfTagsForModel(m.id),
    }))
    return c.json({ models: catalog })
  }
  if (provider === 'horde') {
    const models = await listTextModels(getDecryptedHordeKey(db, userId))
    const catalog: CatalogModel[] = models.map((m) => ({ id: m.name }))
    return c.json({ models: catalog })
  }
  return c.json({ error: `unsupported provider: ${provider}` }, 400)
})

const DEFAULT_NEW_MODEL: ModelConfigInput = {
  provider: 'featherless',
  model: '',
  temperature: 1.0,
  responseLimit: 4096,
  contextLimit: 32000,
  useAuthor: false,
  useEditor: false,
  useWorker: false,
  active: true,
}

const patchSchema = z.object({
  provider: z.enum(['featherless', 'horde']).optional(),
  model: z.string().optional(),
  temperature: z.number().optional(),
  responseLimit: z.number().int().positive().optional(),
  contextLimit: z.number().int().positive().optional(),
  presencePenalty: z.number().nullable().optional(),
  frequencyPenalty: z.number().nullable().optional(),
  repetitionPenalty: z.number().nullable().optional(),
  topP: z.number().nullable().optional(),
  topK: z.number().nullable().optional(),
  minP: z.number().nullable().optional(),
  concurrencyCost: z.number().nullable().optional(),
  useAuthor: z.boolean().optional(),
  useEditor: z.boolean().optional(),
  useWorker: z.boolean().optional(),
  active: z.boolean().optional(),
})

const reorderSchema = z.object({
  orderedIds: z.array(z.string()),
})

// Ensures Config > Agents always reflects the current live state (including the one-time
// migration from the old per-role table) before any read/write below touches the list.
function ensureSeeded(c: Context<{ Variables: AppVariables }>): {
  db: ReturnType<typeof getGlobalDb>
  userId: string
} {
  const db = getGlobalDb()
  const userId = c.get('userId')
  getAgentProfile(userId, 'author') // triggers ensureModelConfigsSeeded as a side effect
  return { db, userId }
}

agentsRoute.get('/', (c) => {
  const { db, userId } = ensureSeeded(c)
  return c.json({ configs: listModelConfigs(db, userId) })
})

agentsRoute.post('/', (c) => {
  const { db, userId } = ensureSeeded(c)
  const created = createModelConfig(db, userId, DEFAULT_NEW_MODEL)
  return c.json({ config: created })
})

agentsRoute.patch('/:id', sValidator('json', patchSchema, validationHook), async (c) => {
  const body = c.req.valid('json')
  const { db, userId } = ensureSeeded(c)
  const patch: Partial<ModelConfigInput> = { ...body }
  if (typeof patch.model === 'string') patch.model = patch.model.trim()

  // When the model string changes, fetch its actual concurrency cost from Featherless
  // so slot reservations match the real per-call cost — no hardcoded guessing.
  if (patch.model && patch.provider !== 'horde') {
    const apiKey = getDecryptedFeatherlessKey(db, userId)
    if (apiKey) {
      try {
        const modelInfo = await getModel(apiKey, patch.model)
        if (modelInfo?.concurrencyCost != null) {
          patch.concurrencyCost = modelInfo.concurrencyCost
        }
      } catch {
        // Model lookup failed — leave concurrencyCost as-is (existing value or null).
        // The concurrency feed's actual limits still prevent oversubscription.
      }
    }
  }

  const updated = updateModelConfig(db, c.req.param('id')!, patch)
  if (!updated) return c.json({ error: 'model config not found' }, 404)
  return c.json({ config: updated })
})

agentsRoute.delete('/:id', (c) => {
  const { db } = ensureSeeded(c)
  deleteModelConfig(db, c.req.param('id'))
  return c.json({ ok: true })
})

agentsRoute.post('/reorder', sValidator('json', reorderSchema, validationHook), (c) => {
  const { orderedIds } = c.req.valid('json')
  const { db, userId } = ensureSeeded(c)
  reorderModelConfigs(db, userId, orderedIds)
  return c.json({ configs: listModelConfigs(db, userId) })
})
