import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { GLOBAL_SCHEMA_SQL } from "./global-schema.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
const GLOBAL_DB_PATH = path.join(DATA_DIR, "global.sqlite");

let db: Database.Database | null = null;

/** Same lightweight stand-in as story-db.ts's ensureColumn — no migration framework yet, and CREATE TABLE IF NOT EXISTS doesn't retroactively add columns to a table created before this one existed. */
function ensureColumn(target: Database.Database, table: string, column: string, ddl: string): void {
  try {
    target.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("duplicate column")) throw err;
  }
}

export function getGlobalDb(): Database.Database {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(GLOBAL_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(GLOBAL_SCHEMA_SQL);
  ensureColumn(db, "agent_configs", "fallback_models", "TEXT");
  ensureColumn(db, "model_configs", "provider", "TEXT NOT NULL DEFAULT 'featherless'");
  ensureColumn(db, "model_configs", "concurrency_cost", "INTEGER");
  // One-time retirement of the banned-phrases stop-list mechanism (replaced by the
  // "banned-phrases" settings_spaces entry exposing refusal-detection prefixes instead —
  // see src/services/refusal-detection.ts). Safe to run every startup: DROP IF EXISTS is a
  // no-op once the table is gone.
  db.exec("DROP TABLE IF EXISTS banned_phrases");
  return db;
}
