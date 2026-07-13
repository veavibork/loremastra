import type Database from 'better-sqlite3'
import { nowIso } from '../lib/time.js'
import type { AgentProfile } from '../config.js'
import type { AgentRole } from './model-config-store.js'

interface RawAgentConfigRow {
  model: string
  temperature: number
  response_limit: number
  context_limit: number
  fallback_models: string | null
}

function parseFallbackModels(raw: string | null): string[] | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((m): m is string => typeof m === 'string')
      : undefined
  } catch {
    return undefined
  }
}

export function getAgentConfigOverride(
  db: Database.Database,
  role: AgentRole,
): AgentProfile | null {
  const row = db
    .prepare(
      `SELECT model, temperature, response_limit, context_limit, fallback_models FROM agent_configs WHERE role = ?`,
    )
    .get(role) as RawAgentConfigRow | undefined
  if (!row) return null
  return {
    model: row.model,
    temperature: row.temperature,
    responseLimit: row.response_limit,
    contextLimit: row.context_limit,
    fallbackModels: parseFallbackModels(row.fallback_models),
  }
}

export function setAgentConfigOverride(
  db: Database.Database,
  role: AgentRole,
  userId: string,
  profile: AgentProfile,
): void {
  db.prepare(
    `INSERT INTO agent_configs (role, user_id, model, temperature, response_limit, context_limit, fallback_models, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(role) DO UPDATE SET
       model = excluded.model,
       temperature = excluded.temperature,
       response_limit = excluded.response_limit,
       context_limit = excluded.context_limit,
       fallback_models = excluded.fallback_models,
       updated_at = excluded.updated_at`,
  ).run(
    role,
    userId,
    profile.model,
    profile.temperature,
    profile.responseLimit,
    profile.contextLimit,
    profile.fallbackModels?.length ? JSON.stringify(profile.fallbackModels) : null,
    nowIso(),
  )
}
