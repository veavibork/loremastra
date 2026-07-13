import type Database from 'better-sqlite3'
import { nowIso } from '../lib/time.js'

interface SettingsSpaceRow {
  json_blob: string
  previous_json_blob: string | null
}

/** Returns the space's current value, seeding it with `defaultValue` on first read if no row exists yet. */
export function getSettingsSpace<T>(
  db: Database.Database,
  userId: string,
  space: string,
  defaultValue: T,
): T {
  const row = db
    .prepare(
      `SELECT json_blob, previous_json_blob FROM settings_spaces WHERE space = ? AND user_id = ?`,
    )
    .get(space, userId) as SettingsSpaceRow | undefined
  if (!row) {
    db.prepare(
      `INSERT INTO settings_spaces (space, user_id, json_blob, previous_json_blob, updated_at) VALUES (?, ?, ?, NULL, ?)`,
    ).run(space, userId, JSON.stringify(defaultValue), nowIso())
    return defaultValue
  }
  return JSON.parse(row.json_blob) as T
}

/** Shifts the current value into previous_json_blob (one-step undo) before storing the new one. */
export function saveSettingsSpace<T>(
  db: Database.Database,
  userId: string,
  space: string,
  value: T,
): T {
  const existing = db
    .prepare(`SELECT json_blob FROM settings_spaces WHERE space = ? AND user_id = ?`)
    .get(space, userId) as { json_blob: string } | undefined
  const updatedAt = nowIso()
  if (existing) {
    db.prepare(
      `UPDATE settings_spaces SET json_blob = ?, previous_json_blob = ?, updated_at = ? WHERE space = ? AND user_id = ?`,
    ).run(JSON.stringify(value), existing.json_blob, updatedAt, space, userId)
  } else {
    db.prepare(
      `INSERT INTO settings_spaces (space, user_id, json_blob, previous_json_blob, updated_at) VALUES (?, ?, ?, NULL, ?)`,
    ).run(space, userId, JSON.stringify(value), updatedAt)
  }
  return value
}

/** Swaps the current and previous values back (one-step undo). Returns the restored value, or null if there's nothing to revert to. */
export function revertSettingsSpace<T>(
  db: Database.Database,
  userId: string,
  space: string,
): T | null {
  const row = db
    .prepare(
      `SELECT json_blob, previous_json_blob FROM settings_spaces WHERE space = ? AND user_id = ?`,
    )
    .get(space, userId) as SettingsSpaceRow | undefined
  if (!row || row.previous_json_blob === null) return null
  db.prepare(
    `UPDATE settings_spaces SET json_blob = ?, previous_json_blob = ?, updated_at = ? WHERE space = ? AND user_id = ?`,
  ).run(row.previous_json_blob, row.json_blob, nowIso(), space, userId)
  return JSON.parse(row.previous_json_blob) as T
}
