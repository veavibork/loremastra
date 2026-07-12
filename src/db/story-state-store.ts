import type Database from 'better-sqlite3'

export type StoryPhase = 'setup' | 'kickoff' | 'story'

export interface StoryState {
  phase: StoryPhase
  kickoffPageId: string | null
  /** @deprecated Derived at read time — see resolveIcStartPageId. DB column retained for legacy rows. */
  /** Raw stored value — NULL means "at the head," resolved by the caller (page-store has no notion of story_state). Use getCurrentPageId in routes/services instead of reading this directly. */
  currentPageId: string | null
  /** The most recent hidden page that existed when the current post-kickoff OOC "update session" started — null before any such session has started. Scopes buildSetupConversation to just this session's turns, without adding a visible marker page of its own. */
  oocSessionStartPageId: string | null
}

interface RawStoryStateRow {
  phase: StoryPhase
  kickoff_page_id: string | null
  current_page_id: string | null
  ooc_session_start_page_id: string | null
}

export function getStoryState(db: Database.Database): StoryState {
  const row = db
    .prepare(
      `SELECT phase, kickoff_page_id, current_page_id, ooc_session_start_page_id FROM story_state WHERE id = 1`,
    )
    .get() as RawStoryStateRow | undefined
  return row
    ? {
        phase: row.phase,
        kickoffPageId: row.kickoff_page_id,
        currentPageId: row.current_page_id,
        oocSessionStartPageId: row.ooc_session_start_page_id,
      }
    : { phase: 'setup', kickoffPageId: null, currentPageId: null, oocSessionStartPageId: null }
}

export function setStoryPhase(db: Database.Database, phase: StoryPhase): void {
  db.prepare(`UPDATE story_state SET phase = ? WHERE id = 1`).run(phase)
}

export function setKickoffPageId(db: Database.Database, pageId: string | null): void {
  db.prepare(`UPDATE story_state SET kickoff_page_id = ? WHERE id = 1`).run(pageId)
}

/** NULL means "at the head" — resolve with findHeadPageId(db, bookId) when this is null. */
export function setCurrentPageId(db: Database.Database, pageId: string | null): void {
  db.prepare(`UPDATE story_state SET current_page_id = ? WHERE id = 1`).run(pageId)
}

export function setOocSessionStartPageId(db: Database.Database, pageId: string | null): void {
  db.prepare(`UPDATE story_state SET ooc_session_start_page_id = ? WHERE id = 1`).run(pageId)
}

/** How far along the unified Undo/Redo ledger (history_event) the user currently is. 0 = before the first event. */
export function getHistoryCursorSeq(db: Database.Database): number {
  const row = db.prepare(`SELECT history_cursor_seq FROM story_state WHERE id = 1`).get() as
    { history_cursor_seq: number } | undefined
  return row?.history_cursor_seq ?? 0
}

export function setHistoryCursorSeq(db: Database.Database, seq: number): void {
  db.prepare(`UPDATE story_state SET history_cursor_seq = ? WHERE id = 1`).run(seq)
}
