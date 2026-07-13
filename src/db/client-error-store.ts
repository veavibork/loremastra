import type Database from 'better-sqlite3'
import { newId } from '../lib/uuid.js'
import { nowIso } from '../lib/time.js'

export interface ClientErrorRow {
  id: string
  severity: string
  message: string
  url: string | null
  userAgent: string | null
  createdAt: string
}

interface RawClientErrorRow {
  id: string
  severity: string
  message: string
  url: string | null
  user_agent: string | null
  created_at: string
}

function mapRow(row: RawClientErrorRow): ClientErrorRow {
  return {
    id: row.id,
    severity: row.severity,
    message: row.message,
    url: row.url,
    userAgent: row.user_agent,
    createdAt: row.created_at,
  }
}

export function createClientError(
  db: Database.Database,
  input: { severity: string; message: string; url?: string | null; userAgent?: string | null },
): ClientErrorRow {
  const id = newId()
  const createdAt = nowIso()
  db.prepare(
    `INSERT INTO client_errors (id, severity, message, url, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.severity, input.message, input.url ?? null, input.userAgent ?? null, createdAt)
  return {
    id,
    severity: input.severity,
    message: input.message,
    url: input.url ?? null,
    userAgent: input.userAgent ?? null,
    createdAt,
  }
}

export function listClientErrors(
  db: Database.Database,
  opts?: { limit?: number },
): ClientErrorRow[] {
  const limit = opts?.limit ?? 200
  const rows = db
    .prepare(`SELECT * FROM client_errors ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as RawClientErrorRow[]
  return rows.map(mapRow)
}
