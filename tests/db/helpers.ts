import Database from "better-sqlite3";
import { STORY_SCHEMA_SQL } from "../../src/db/story-schema.js";
import { GLOBAL_SCHEMA_SQL } from "../../src/db/global-schema.js";

/** Fresh in-memory DB with story schema + migration columns. Foreign keys OFF for focused table testing. */
export function createStoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(STORY_SCHEMA_SQL);
  // Columns added by ensureColumn in story-db.ts migrations.
  db.exec(`ALTER TABLE jobs ADD COLUMN input_token_estimate INTEGER`);
  db.exec(`ALTER TABLE jobs ADD COLUMN horde_request_id TEXT`);
  db.exec(`ALTER TABLE jobs ADD COLUMN result_summary TEXT`);
  db.exec(`ALTER TABLE page ADD COLUMN memory_content_stamp TEXT`);
  db.exec(`ALTER TABLE text ADD COLUMN compress_metrics TEXT`);
  db.exec(`ALTER TABLE story_state ADD COLUMN history_cursor_seq INTEGER NOT NULL DEFAULT 0`);
  db.exec(`ALTER TABLE story_state ADD COLUMN ooc_session_start_page_id TEXT`);
  return db;
}

/** Fresh in-memory DB with global schema. Foreign keys OFF. */
export function createGlobalDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(GLOBAL_SCHEMA_SQL);
  return db;
}