import { mkdirSync } from 'node:fs'
import Database from 'better-sqlite3'
import { GLOBAL_SCHEMA_SQL } from './global-schema.js'
import { dataDir, globalDbPath } from './data-paths.js'

const DATA_DIR = dataDir()
const GLOBAL_DB_PATH = globalDbPath()

let db: Database.Database | null = null

/** Same lightweight stand-in as story-db.ts's ensureColumn — no migration framework yet, and CREATE TABLE IF NOT EXISTS doesn't retroactively add columns to a table created before this one existed. */
function ensureColumn(target: Database.Database, table: string, column: string, ddl: string): void {
  try {
    target.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('duplicate column')) throw err
  }
}

export function getGlobalDb(): Database.Database {
  if (db) return db
  mkdirSync(DATA_DIR, { recursive: true })
  db = new Database(GLOBAL_DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.exec(GLOBAL_SCHEMA_SQL)
  ensureColumn(db, 'agent_configs', 'fallback_models', 'TEXT')
  ensureColumn(db, 'model_configs', 'provider', "TEXT NOT NULL DEFAULT 'featherless'")
  ensureColumn(db, 'model_configs', 'concurrency_cost', 'INTEGER')
  ensureColumn(db, 'users', 'featherless_key_encrypted', 'TEXT')
  ensureColumn(db, 'users', 'horde_key_encrypted', 'TEXT')
  ensureColumn(db, 'model_format_profiles', 'drift_detected_at', 'TEXT')
  ensureColumn(db, 'model_format_profiles', 'drift_reasons', 'TEXT')
  // One-time retirement of the banned-phrases stop-list mechanism (replaced by the
  // "banned-phrases" settings_spaces entry exposing refusal-detection prefixes instead —
  // see src/services/refusal-detection.ts). Safe to run every startup: DROP IF EXISTS is a
  // no-op once the table is gone.
  db.exec('DROP TABLE IF EXISTS banned_phrases')
  return db
}
