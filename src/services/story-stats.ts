import type Database from 'better-sqlite3'
import { getBookByType } from '../db/book-store.js'
import { countIcPosts } from './story-to-date-corpus.js'

export interface StoryStats {
  /** Every text row in game+logbook books (includes superseded retry/edit versions). */
  chatRows: number
  /** In-character posts on the active chain from kickoff onward (one per page). */
  icPosts: number
  worldbookRows: number
  lastPlayedAt: string | null
}

/** "Chat" = setup dialogue + story posts (game/logbook books), excluding worldbook entries' own text rows. */
export function getStoryStats(db: Database.Database): StoryStats {
  const chat = db
    .prepare(
      `SELECT COUNT(*) AS n, MAX(t.created_at) AS last
       FROM text t
       JOIN page p ON p.id = t.page_id
       JOIN book b ON b.id = p.book_id
       WHERE b.book_type IN ('game', 'logbook') AND t.hidden = 0`,
    )
    .get() as { n: number; last: string | null }

  const worldbook = db.prepare(`SELECT COUNT(*) AS n FROM worldbook_entry`).get() as { n: number }

  const logbook = getBookByType(db, 'logbook')
  const icPosts = logbook ? countIcPosts(db, logbook.id) : 0

  return { chatRows: chat.n, icPosts, worldbookRows: worldbook.n, lastPlayedAt: chat.last }
}
