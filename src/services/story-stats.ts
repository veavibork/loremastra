import type Database from "better-sqlite3";

export interface StoryStats {
  chatRows: number;
  worldbookRows: number;
  lastPlayedAt: string | null;
}

/** "Chat" = setup dialogue + story posts (game/logbook books), excluding worldbook entries' own text rows. */
export function getStoryStats(db: Database.Database): StoryStats {
  const chat = db
    .prepare(
      `SELECT COUNT(*) AS n, MAX(t.created_at) AS last
       FROM text t
       JOIN page p ON p.id = t.page_id
       JOIN book b ON b.id = p.book_id
       WHERE b.book_type IN ('game', 'logbook') AND t.hidden = 0`
    )
    .get() as { n: number; last: string | null };

  const worldbook = db.prepare(`SELECT COUNT(*) AS n FROM worldbook_entry`).get() as { n: number };

  return { chatRows: chat.n, worldbookRows: worldbook.n, lastPlayedAt: chat.last };
}
