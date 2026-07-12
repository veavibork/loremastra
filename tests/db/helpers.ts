import Database from "better-sqlite3";
import { STORY_SCHEMA_SQL } from "../../src/db/story-schema.js";
import { GLOBAL_SCHEMA_SQL } from "../../src/db/global-schema.js";

/** Fresh in-memory DB with story schema + migration columns. */
export function createStoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(STORY_SCHEMA_SQL);
  // Columns added at migration time, not in the base schema.
  db.exec(`ALTER TABLE jobs ADD COLUMN input_token_estimate INTEGER`);
  db.exec(`ALTER TABLE jobs ADD COLUMN horde_request_id TEXT`);
  db.exec(`ALTER TABLE jobs ADD COLUMN result_summary TEXT`);
  return db;
}

/** Fresh in-memory DB with global schema. */
export function createGlobalDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(GLOBAL_SCHEMA_SQL);
  return db;
}