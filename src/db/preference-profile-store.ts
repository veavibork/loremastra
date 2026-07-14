import type Database from 'better-sqlite3'
import { encryptSecret, decryptSecret } from '../lib/crypto.js'
import { newId } from '../lib/uuid.js'
import { nowIso } from '../lib/time.js'

export interface PreferenceProfileRow {
  id: string
  userId: string
  name: string
  settings: Record<string, unknown>
  isActive: boolean
  createdAt: string
  updatedAt: string
}

interface RawRow {
  id: string
  user_id: string
  name: string
  encrypted_settings_json: string
  is_active: number
  created_at: string
  updated_at: string
}

function mapRow(row: RawRow): PreferenceProfileRow {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    settings: JSON.parse(decryptSecret(row.encrypted_settings_json)),
    isActive: !!row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listPreferenceProfiles(
  db: Database.Database,
  userId: string,
): PreferenceProfileRow[] {
  const rows = db
    .prepare(`SELECT * FROM preference_profiles WHERE user_id = ? ORDER BY created_at ASC`)
    .all(userId) as RawRow[]
  return rows.map(mapRow)
}

export function getPreferenceProfile(
  db: Database.Database,
  id: string,
  userId: string,
): PreferenceProfileRow | null {
  const row = db
    .prepare(`SELECT * FROM preference_profiles WHERE id = ? AND user_id = ?`)
    .get(id, userId) as RawRow | undefined
  return row ? mapRow(row) : null
}

export function getActivePreferenceProfile(
  db: Database.Database,
  userId: string,
): PreferenceProfileRow | null {
  const row = db
    .prepare(`SELECT * FROM preference_profiles WHERE user_id = ? AND is_active = 1`)
    .get(userId) as RawRow | undefined
  return row ? mapRow(row) : null
}

export function createPreferenceProfile(
  db: Database.Database,
  userId: string,
  input: { name: string; settings: Record<string, unknown> },
): PreferenceProfileRow {
  const id = newId()
  const now = nowIso()
  const encrypted = encryptSecret(JSON.stringify(input.settings))
  db.prepare(
    `INSERT INTO preference_profiles (id, user_id, name, encrypted_settings_json, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
  ).run(id, userId, input.name, encrypted, now, now)
  return getPreferenceProfile(db, id, userId)!
}

export function updatePreferenceProfile(
  db: Database.Database,
  id: string,
  userId: string,
  input: { name?: string; settings?: Record<string, unknown> },
): PreferenceProfileRow | null {
  const existing = getPreferenceProfile(db, id, userId)
  if (!existing) return null

  const now = nowIso()
  if (input.name !== undefined && input.settings !== undefined) {
    const encrypted = encryptSecret(JSON.stringify(input.settings))
    db.prepare(
      `UPDATE preference_profiles SET name = ?, encrypted_settings_json = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    ).run(input.name, encrypted, now, id, userId)
  } else if (input.name !== undefined) {
    db.prepare(
      `UPDATE preference_profiles SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    ).run(input.name, now, id, userId)
  } else if (input.settings !== undefined) {
    const encrypted = encryptSecret(JSON.stringify(input.settings))
    db.prepare(
      `UPDATE preference_profiles SET encrypted_settings_json = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    ).run(encrypted, now, id, userId)
  }
  return getPreferenceProfile(db, id, userId)
}

export function setActivePreferenceProfile(
  db: Database.Database,
  id: string,
  userId: string,
): PreferenceProfileRow | null {
  const existing = getPreferenceProfile(db, id, userId)
  if (!existing) return null
  const now = nowIso()
  // Deactivate all, then activate the target — single transaction
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE preference_profiles SET is_active = 0, updated_at = ? WHERE user_id = ?`,
    ).run(now, userId)
    db.prepare(
      `UPDATE preference_profiles SET is_active = 1, updated_at = ? WHERE id = ? AND user_id = ?`,
    ).run(now, id, userId)
  })
  tx()
  return getPreferenceProfile(db, id, userId)
}

export function deletePreferenceProfile(
  db: Database.Database,
  id: string,
  userId: string,
): boolean {
  const result = db
    .prepare(`DELETE FROM preference_profiles WHERE id = ? AND user_id = ?`)
    .run(id, userId)
  return result.changes > 0
}
