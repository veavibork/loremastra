import type Database from "better-sqlite3";

export type StoryPhase = "setup" | "kickoff" | "story";

export interface StoryState {
  phase: StoryPhase;
  kickoffPageId: string | null;
  /** Raw stored value — NULL means "at the head," resolved by the caller (page-store has no notion of story_state). Use getCurrentPageId in routes/services instead of reading this directly. */
  currentPageId: string | null;
}

interface RawStoryStateRow {
  phase: StoryPhase;
  kickoff_page_id: string | null;
  current_page_id: string | null;
}

export function getStoryState(db: Database.Database): StoryState {
  const row = db.prepare(`SELECT phase, kickoff_page_id, current_page_id FROM story_state WHERE id = 1`).get() as
    | RawStoryStateRow
    | undefined;
  return row
    ? { phase: row.phase, kickoffPageId: row.kickoff_page_id, currentPageId: row.current_page_id }
    : { phase: "setup", kickoffPageId: null, currentPageId: null };
}

export function setStoryPhase(db: Database.Database, phase: StoryPhase): void {
  db.prepare(`UPDATE story_state SET phase = ? WHERE id = 1`).run(phase);
}

export function setKickoffPageId(db: Database.Database, pageId: string | null): void {
  db.prepare(`UPDATE story_state SET kickoff_page_id = ? WHERE id = 1`).run(pageId);
}

/** NULL means "at the head" — resolve with findHeadPageId(db, bookId) when this is null. */
export function setCurrentPageId(db: Database.Database, pageId: string | null): void {
  db.prepare(`UPDATE story_state SET current_page_id = ? WHERE id = 1`).run(pageId);
}
