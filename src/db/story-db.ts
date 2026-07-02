import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { STORY_SCHEMA_SQL } from "./story-schema.js";
import { recoverStaleJobs } from "./job-store.js";

const STORIES_DIR = path.resolve(process.cwd(), "data", "stories");

const openStoryDbs = new Map<string, Database.Database>();

export function storyDbPath(storyId: string): string {
  return path.join(STORIES_DIR, `${storyId}.sqlite`);
}

/**
 * `CREATE TABLE IF NOT EXISTS` doesn't retroactively add columns to a table
 * that already exists from before this column was added to the schema — no
 * migration framework exists yet (dev-only, single-file-per-story), so this
 * is the lightweight stand-in: try the ALTER, swallow the "already there"
 * error. Safe to call unconditionally on every open.
 */
function ensureColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("duplicate column")) throw err;
  }
}

/**
 * `selected_fork_page_id` existed in the schema from day one but nothing
 * ever wrote to it until page chain traversal became fork-aware (Milestone
 * D) — every page created before that has it NULL. Since findHeadPageId now
 * walks forward via that pointer and stops the instant it's NULL, an
 * unmigrated story's entire log beyond the root would silently vanish.
 * Backfills every page that has exactly the situation the old "no children"
 * check used to handle correctly (a single child, no real fork) — true
 * leaves (no children) correctly stay NULL, which is what makes them the head.
 */
function backfillSelectedForks(db: Database.Database): void {
  db.exec(`
    UPDATE page
    SET selected_fork_page_id = (
      SELECT child.id FROM page child
      WHERE child.prev_page_id = page.id
      ORDER BY child.created_at DESC
      LIMIT 1
    )
    WHERE selected_fork_page_id IS NULL
    AND EXISTS (SELECT 1 FROM page child WHERE child.prev_page_id = page.id)
  `);
}

export function closeStoryDb(storyId: string): void {
  const db = openStoryDbs.get(storyId);
  if (!db) return;
  db.close();
  openStoryDbs.delete(storyId);
}

export function getStoryDb(storyId: string): Database.Database {
  const existing = openStoryDbs.get(storyId);
  if (existing) return existing;

  mkdirSync(STORIES_DIR, { recursive: true });
  const db = new Database(storyDbPath(storyId));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(STORY_SCHEMA_SQL);
  ensureColumn(db, "story_state", "current_page_id", "TEXT REFERENCES page(id)");
  ensureColumn(db, "jobs", "model", "TEXT");
  ensureColumn(db, "jobs", "token_estimate", "INTEGER");
  backfillSelectedForks(db);
  recoverStaleJobs(db);
  openStoryDbs.set(storyId, db);
  return db;
}
