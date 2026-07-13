import type Database from 'better-sqlite3'
import { newId } from '../lib/uuid.js'
import { nowIso } from '../lib/time.js'
import { getGlobalDb } from './global-db.js'

export interface SessionRow {
  id: string
  userId: string
  createdAt: string
  lastSeenAt: string
  revokedAt: string | null
}

interface RawSessionRow {
  id: string
  user_id: string
  created_at: string
  last_seen_at: string
  revoked_at: string | null
}

function mapRow(row: RawSessionRow): SessionRow {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  }
}

/** Atomically evicts whichever session currently holds the claim (if any) and installs a new one — this is "claim." */
export function createSession(db: Database.Database, userId: string): SessionRow {
  const id = newId()
  const now = nowIso()
  const tx = db.transaction(() => {
    db.prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`).run(
      now,
      userId,
    )
    db.prepare(
      `INSERT INTO sessions (id, user_id, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, NULL)`,
    ).run(id, userId, now, now)
  })
  tx()
  return getSession(db, id)!
}

/** The currently-live claim, if any. At most one row should ever match; ORDER BY/LIMIT is defensive, not load-bearing. */
export function getActiveSession(db: Database.Database, userId: string): SessionRow | null {
  const row = db
    .prepare(
      `SELECT * FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    )
    .get(userId) as RawSessionRow | undefined
  return row ? mapRow(row) : null
}

/** Any session by id, revoked or not — used to show a superseded session's own last-seen time even after eviction. */
export function getSession(db: Database.Database, id: string): SessionRow | null {
  const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as RawSessionRow | undefined
  return row ? mapRow(row) : null
}

export function touchSession(db: Database.Database, id: string): void {
  db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`).run(nowIso(), id)
}

/**
 * Revokes the active claim without installing a new one, so the next HTTP request from whatever
 * browser tab was showing this data gets a 409 "unclaimed" and reloads through the same claim/
 * reclaim flow a superseding session already triggers — used after a direct DB write (dev-server
 * tools, ad hoc scripts) bypasses the HTTP layer entirely and so can't otherwise signal "the data
 * under you changed." Not access control, just a forced refresh.
 */
export function invalidateActiveSession(db: Database.Database, userId: string): void {
  db.prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`).run(
    nowIso(),
    userId,
  )
}

/**
 * Revokes every currently-active claim, across every user — a direct-DB write (dev-server tools,
 * ad hoc scripts) can't know which user's data it touched, so the safe behavior is to kick
 * everyone back through claim rather than guess a single affected user.
 */
export function invalidateAllActiveSessions(db: Database.Database): void {
  db.prepare(`UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL`).run(nowIso())
}

/**
 * Zero-argument convenience for the common case (dev-server tools, ad hoc scripts): open the
 * global DB and invalidate every currently-claimed session. Call this once after a direct-DB
 * write is done, not per statement.
 */
export function notifyDirectMutation(): void {
  const db = getGlobalDb()
  invalidateAllActiveSessions(db)
}
