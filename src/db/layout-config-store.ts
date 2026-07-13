import type Database from 'better-sqlite3'
import { newId } from '../lib/uuid.js'
import { nowIso } from '../lib/time.js'

export interface LayoutConfigRow {
  id: string
  userId: string
  name: string
  configJson: string
  isActive: boolean
  createdAt: string
  updatedAt: string
}

interface RawLayoutConfigRow {
  id: string
  user_id: string
  name: string
  config_json: string
  is_active: number
  created_at: string
  updated_at: string
}

function mapRow(row: RawLayoutConfigRow): LayoutConfigRow {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    configJson: row.config_json,
    isActive: !!row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createLayoutConfig(
  db: Database.Database,
  input: { userId: string; name: string; configJson: string; isActive?: boolean },
): LayoutConfigRow {
  const id = newId()
  const createdAt = nowIso()
  const run = db.transaction(() => {
    if (input.isActive) {
      db.prepare(`UPDATE layout_configs SET is_active = 0 WHERE user_id = ?`).run(input.userId)
    }
    db.prepare(
      `INSERT INTO layout_configs (id, user_id, name, config_json, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.userId,
      input.name,
      input.configJson,
      input.isActive ? 1 : 0,
      createdAt,
      createdAt,
    )
  })
  run()
  return getLayoutConfig(db, id)!
}

export function getLayoutConfig(db: Database.Database, id: string): LayoutConfigRow | null {
  const row = db.prepare(`SELECT * FROM layout_configs WHERE id = ?`).get(id) as
    RawLayoutConfigRow | undefined
  return row ? mapRow(row) : null
}

export function getActiveLayoutConfig(
  db: Database.Database,
  userId: string,
): LayoutConfigRow | null {
  const row = db
    .prepare(`SELECT * FROM layout_configs WHERE user_id = ? AND is_active = 1 LIMIT 1`)
    .get(userId) as RawLayoutConfigRow | undefined
  return row ? mapRow(row) : null
}

export function listLayoutConfigs(db: Database.Database, userId: string): LayoutConfigRow[] {
  const rows = db
    .prepare(`SELECT * FROM layout_configs WHERE user_id = ? ORDER BY created_at ASC`)
    .all(userId) as RawLayoutConfigRow[]
  return rows.map(mapRow)
}

export function updateLayoutConfigJson(
  db: Database.Database,
  id: string,
  configJson: string,
): LayoutConfigRow {
  db.prepare(`UPDATE layout_configs SET config_json = ?, updated_at = ? WHERE id = ?`).run(
    configJson,
    nowIso(),
    id,
  )
  return getLayoutConfig(db, id)!
}

export function setActiveLayoutConfig(db: Database.Database, userId: string, id: string): void {
  const run = db.transaction(() => {
    db.prepare(`UPDATE layout_configs SET is_active = 0 WHERE user_id = ?`).run(userId)
    db.prepare(
      `UPDATE layout_configs SET is_active = 1, updated_at = ? WHERE id = ? AND user_id = ?`,
    ).run(nowIso(), id, userId)
  })
  run()
}
