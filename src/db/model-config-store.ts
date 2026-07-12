import type Database from 'better-sqlite3'
import { newId } from '../uuid.js'
import { nowIso } from './time.js'

export type AgentRole = 'author' | 'worker' | 'editor'

export type Provider = 'featherless' | 'horde'

export interface ModelConfigRow {
  id: string
  userId: string
  provider: Provider
  model: string
  temperature: number
  responseLimit: number
  contextLimit: number
  presencePenalty: number | null
  frequencyPenalty: number | null
  repetitionPenalty: number | null
  topP: number | null
  topK: number | null
  minP: number | null
  /** Featherless-reported per-call concurrency cost against the account's slot limit (src/queue/slots.ts) — a property of the model, not the job type that happens to use it. Null means "unknown," and callers fall back to a per-role default (see agent-config.ts). */
  concurrencyCost: number | null
  useAuthor: boolean
  useEditor: boolean
  useWorker: boolean
  active: boolean
  sortOrder: number
  successCount: number
  failCount: number
  inputTokens: number
  outputTokens: number
  createdAt: string
  updatedAt: string
}

interface RawRow {
  id: string
  user_id: string
  provider: Provider
  model: string
  temperature: number
  response_limit: number
  context_limit: number
  presence_penalty: number | null
  frequency_penalty: number | null
  repetition_penalty: number | null
  top_p: number | null
  top_k: number | null
  min_p: number | null
  concurrency_cost: number | null
  use_author: number
  use_editor: number
  use_worker: number
  active: number
  sort_order: number
  success_count: number
  fail_count: number
  input_tokens: number
  output_tokens: number
  created_at: string
  updated_at: string
}

function mapRow(row: RawRow): ModelConfigRow {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    model: row.model,
    temperature: row.temperature,
    responseLimit: row.response_limit,
    contextLimit: row.context_limit,
    presencePenalty: row.presence_penalty,
    frequencyPenalty: row.frequency_penalty,
    repetitionPenalty: row.repetition_penalty,
    topP: row.top_p,
    topK: row.top_k,
    minP: row.min_p,
    concurrencyCost: row.concurrency_cost,
    useAuthor: !!row.use_author,
    useEditor: !!row.use_editor,
    useWorker: !!row.use_worker,
    active: !!row.active,
    sortOrder: row.sort_order,
    successCount: row.success_count,
    failCount: row.fail_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listModelConfigs(db: Database.Database, userId: string): ModelConfigRow[] {
  const rows = db
    .prepare(`SELECT * FROM model_configs WHERE user_id = ? ORDER BY sort_order ASC`)
    .all(userId) as RawRow[]
  return rows.map(mapRow)
}

export function getModelConfig(db: Database.Database, id: string): ModelConfigRow | null {
  const row = db.prepare(`SELECT * FROM model_configs WHERE id = ?`).get(id) as RawRow | undefined
  return row ? mapRow(row) : null
}

export interface ModelConfigInput {
  provider: Provider
  model: string
  temperature: number
  responseLimit: number
  contextLimit: number
  presencePenalty?: number | null
  frequencyPenalty?: number | null
  repetitionPenalty?: number | null
  topP?: number | null
  topK?: number | null
  minP?: number | null
  concurrencyCost?: number | null
  useAuthor: boolean
  useEditor: boolean
  useWorker: boolean
  active: boolean
}

export function createModelConfig(
  db: Database.Database,
  userId: string,
  input: ModelConfigInput,
): ModelConfigRow {
  const id = newId()
  const now = nowIso()
  const maxOrder = (
    db.prepare(`SELECT MAX(sort_order) AS m FROM model_configs WHERE user_id = ?`).get(userId) as {
      m: number | null
    }
  ).m
  const sortOrder = (maxOrder ?? -1) + 1

  db.prepare(
    `INSERT INTO model_configs (
       id, user_id, provider, model, temperature, response_limit, context_limit,
       presence_penalty, frequency_penalty, repetition_penalty, top_p, top_k, min_p, concurrency_cost,
       use_author, use_editor, use_worker, active, sort_order,
       success_count, fail_count, input_tokens, output_tokens, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?)`,
  ).run(
    id,
    userId,
    input.provider,
    input.model,
    input.temperature,
    input.responseLimit,
    input.contextLimit,
    input.presencePenalty ?? null,
    input.frequencyPenalty ?? null,
    input.repetitionPenalty ?? null,
    input.topP ?? null,
    input.topK ?? null,
    input.minP ?? null,
    input.concurrencyCost ?? null,
    input.useAuthor ? 1 : 0,
    input.useEditor ? 1 : 0,
    input.useWorker ? 1 : 0,
    input.active ? 1 : 0,
    sortOrder,
    now,
    now,
  )
  return getModelConfig(db, id)!
}

export function updateModelConfig(
  db: Database.Database,
  id: string,
  patch: Partial<ModelConfigInput>,
): ModelConfigRow | null {
  const current = getModelConfig(db, id)
  if (!current) return null

  const next: ModelConfigInput = {
    provider: patch.provider ?? current.provider,
    model: patch.model ?? current.model,
    temperature: patch.temperature ?? current.temperature,
    responseLimit: patch.responseLimit ?? current.responseLimit,
    contextLimit: patch.contextLimit ?? current.contextLimit,
    presencePenalty:
      patch.presencePenalty !== undefined ? patch.presencePenalty : current.presencePenalty,
    frequencyPenalty:
      patch.frequencyPenalty !== undefined ? patch.frequencyPenalty : current.frequencyPenalty,
    repetitionPenalty:
      patch.repetitionPenalty !== undefined ? patch.repetitionPenalty : current.repetitionPenalty,
    topP: patch.topP !== undefined ? patch.topP : current.topP,
    topK: patch.topK !== undefined ? patch.topK : current.topK,
    minP: patch.minP !== undefined ? patch.minP : current.minP,
    concurrencyCost:
      patch.concurrencyCost !== undefined ? patch.concurrencyCost : current.concurrencyCost,
    useAuthor: patch.useAuthor ?? current.useAuthor,
    useEditor: patch.useEditor ?? current.useEditor,
    useWorker: patch.useWorker ?? current.useWorker,
    active: patch.active ?? current.active,
  }

  db.prepare(
    `UPDATE model_configs SET
       provider = ?, model = ?, temperature = ?, response_limit = ?, context_limit = ?,
       presence_penalty = ?, frequency_penalty = ?, repetition_penalty = ?, top_p = ?, top_k = ?, min_p = ?, concurrency_cost = ?,
       use_author = ?, use_editor = ?, use_worker = ?, active = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    next.provider,
    next.model,
    next.temperature,
    next.responseLimit,
    next.contextLimit,
    next.presencePenalty ?? null,
    next.frequencyPenalty ?? null,
    next.repetitionPenalty ?? null,
    next.topP ?? null,
    next.topK ?? null,
    next.minP ?? null,
    next.concurrencyCost ?? null,
    next.useAuthor ? 1 : 0,
    next.useEditor ? 1 : 0,
    next.useWorker ? 1 : 0,
    next.active ? 1 : 0,
    nowIso(),
    id,
  )
  return getModelConfig(db, id)
}

export function deleteModelConfig(db: Database.Database, id: string): void {
  db.prepare(`DELETE FROM model_configs WHERE id = ?`).run(id)
}

/** Rewrites sort_order sequentially to match the given order — the fallback chain position for every role at once, since role eligibility is a separate per-row flag. */
export function reorderModelConfigs(
  db: Database.Database,
  userId: string,
  orderedIds: string[],
): void {
  const update = db.prepare(
    `UPDATE model_configs SET sort_order = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
  )
  const now = nowIso()
  const tx = db.transaction((ids: string[]) => {
    ids.forEach((id, index) => update.run(index, now, id, userId))
  })
  tx(orderedIds)
}

export function recordModelOutcome(
  db: Database.Database,
  id: string,
  outcome: { success: boolean; inputTokens: number; outputTokens: number },
): void {
  db.prepare(
    `UPDATE model_configs SET
       success_count = success_count + ?,
       fail_count = fail_count + ?,
       input_tokens = input_tokens + ?,
       output_tokens = output_tokens + ?
     WHERE id = ?`,
  ).run(
    outcome.success ? 1 : 0,
    outcome.success ? 0 : 1,
    outcome.inputTokens,
    outcome.outputTokens,
    id,
  )
}
