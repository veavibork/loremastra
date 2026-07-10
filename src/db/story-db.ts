import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { STORY_SCHEMA_SQL } from "./story-schema.js";
import { recoverStaleJobs } from "./job-store.js";
import { setMemoryContentStamp } from "./page-store.js";
import { computeTextContentStamp } from "../services/content-stamp.js";

import { storiesDir, storyDbPath as storyDbPathForId } from "./data-paths.js";

const STORIES_DIR = storiesDir();

export function storyDbPath(storyId: string): string {
  return storyDbPathForId(storyId);
}

const openStoryDbs = new Map<string, Database.Database>();

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

/** Same lightweight stand-in as ensureColumn, for the rarer case of dropping a column. */
function dropColumnIfExists(db: Database.Database, table: string, column: string): void {
  try {
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("no such column")) throw err;
  }
}

/**
 * worldbook_entry's shape changed incompatibly (six typed schemas with is_pc/name ->
 * three freeform types, content-only) as part of the tags/prompts/worldbook refactor.
 * This is a dev-only, single-file-per-story codebase with no real users yet, so rather
 * than inventing lossy heuristics to carry old structured entries into the new freeform
 * shape, old rows are just dropped -- their underlying page/text rows are orphaned, not
 * deleted, which is harmless since listWorldbookEntries only surfaces rows that still
 * join to a live worldbook_entry row.
 */
function migrateWorldbookEntryShape(db: Database.Database): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'worldbook_entry'`)
    .get() as { sql: string } | undefined;
  if (!row || !row.sql.includes("'setting'")) return;

  db.exec(`
    DROP TABLE worldbook_entry;
    DROP INDEX IF EXISTS idx_worldbook_singleton_setting;
    DROP INDEX IF EXISTS idx_worldbook_singleton_register;
    DROP INDEX IF EXISTS idx_worldbook_singleton_pc;
  `);
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

/** Pre-stamp stories: adopt stamps for rows that already have gen_extract (avoids mass recompress). */
function backfillMemoryContentStamps(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT p.id AS page_id, t.gen_package AS gen_package
       FROM page p
       JOIN text t ON t.id = p.selected_text_id
       WHERE p.memory_content_stamp IS NULL
         AND t.gen_extract IS NOT NULL
         AND t.broken = 0
         AND t.gen_package IS NOT NULL`
    )
    .all() as Array<{ page_id: string; gen_package: string }>;

  for (const row of rows) {
    const stamp = computeTextContentStamp({
      id: "",
      createdAt: "",
      pageId: row.page_id,
      priorTextId: null,
      role: "agent",
      sourcePageId: null,
      hidden: false,
      broken: false,
      genRequest: null,
      genPackage: row.gen_package,
      genMetrics: null,
      genExtract: "x",
      compressMetrics: null,
    });
    if (stamp) setMemoryContentStamp(db, row.page_id, stamp);
  }
}

/**
 * jobs.job_type's CHECK constraint predates 'tag-gen'/'story-name' -- SQLite can't ALTER a
 * CHECK constraint in place, so a story DB file created before this change would reject any
 * job of either new type at the INSERT. Detected by sniffing the table's own stored CREATE
 * statement (same technique as migrateWorldbookEntryShape above) rather than a version counter,
 * consistent with this dev-only, no-migration-framework codebase. Unlike that migration, job
 * rows are worth keeping (they're the Logs/Debug telemetry history), so this renames the old
 * table aside and lets STORY_SCHEMA_SQL create a fresh one in its place below; the rows get
 * copied back by finishJobTypeCheckMigration once the fresh table has caught up on the
 * ensureColumn'd columns too.
 */
function migrateJobTypeCheck(db: Database.Database): void {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'`).get() as { sql: string } | undefined;
  // Sniff the newest job type in the stored CHECK — its presence implies the older ones too,
  // so migrating whenever it's absent covers every pre-fold DB in one condition.
  if (!row || row.sql.includes("'story-to-date-fold'")) return;
  db.exec(`ALTER TABLE jobs RENAME TO jobs_pre_tag_gen_migration`);
  // The renamed table may itself predate one of these three (e.g. a story DB last opened
  // before Horde support existed won't have horde_request_id yet) -- back-fill them here too,
  // not just on the fresh table below, so finishJobTypeCheckMigration's copy has a matching
  // column set on both sides regardless of how old this particular file is.
  ensureColumn(db, "jobs_pre_tag_gen_migration", "model", "TEXT");
  ensureColumn(db, "jobs_pre_tag_gen_migration", "token_estimate", "INTEGER");
  ensureColumn(db, "jobs_pre_tag_gen_migration", "horde_request_id", "TEXT");
  ensureColumn(db, "jobs_pre_tag_gen_migration", "elapsed_ms", "INTEGER");
}

/** Second half of migrateJobTypeCheck -- see its doc comment. Must run after the ensureColumn
 * calls for jobs' model/token_estimate/horde_request_id, since the copy needs both tables to
 * have identical columns. */
function finishJobTypeCheckMigration(db: Database.Database): void {
  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jobs_pre_tag_gen_migration'`)
    .get();
  if (!exists) return;
  db.exec(`
    INSERT INTO jobs (id, created_at, target_text_id, target_archive_id, target_story_to_date_id, job_type, status, priority, slot_cost, started_at, finished_at, error, cancel_requested, model, token_estimate, horde_request_id, elapsed_ms)
    SELECT id, created_at, target_text_id, target_archive_id, NULL, job_type, status, priority, slot_cost, started_at, finished_at, error, cancel_requested, model, token_estimate, horde_request_id, elapsed_ms
    FROM jobs_pre_tag_gen_migration;
    DROP TABLE jobs_pre_tag_gen_migration;
  `);
}

/** Same table-rename technique as migrateJobTypeCheck — adds 'worldbook-compact' to jobs.job_type CHECK. */
function migrateJobTypeWorldbookCompact(db: Database.Database): void {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'`).get() as { sql: string } | undefined;
  if (!row || row.sql.includes("'worldbook-compact'")) return;
  db.exec(`ALTER TABLE jobs RENAME TO jobs_pre_worldbook_compact_migration`);
  ensureColumn(db, "jobs_pre_worldbook_compact_migration", "model", "TEXT");
  ensureColumn(db, "jobs_pre_worldbook_compact_migration", "token_estimate", "INTEGER");
  ensureColumn(db, "jobs_pre_worldbook_compact_migration", "input_token_estimate", "INTEGER");
  ensureColumn(db, "jobs_pre_worldbook_compact_migration", "horde_request_id", "TEXT");
  ensureColumn(db, "jobs_pre_worldbook_compact_migration", "elapsed_ms", "INTEGER");
  ensureColumn(db, "jobs_pre_worldbook_compact_migration", "target_story_to_date_id", "TEXT REFERENCES story_to_date_segment(id)");
}

function finishJobTypeWorldbookCompactMigration(db: Database.Database): void {
  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jobs_pre_worldbook_compact_migration'`)
    .get();
  if (!exists) return;
  db.exec(`
    INSERT INTO jobs (id, created_at, target_text_id, target_archive_id, target_story_to_date_id, job_type, status, priority, slot_cost, started_at, finished_at, error, cancel_requested, model, token_estimate, horde_request_id, elapsed_ms)
    SELECT id, created_at, target_text_id, target_archive_id, target_story_to_date_id, job_type, status, priority, slot_cost, started_at, finished_at, error, cancel_requested, model, token_estimate, horde_request_id, elapsed_ms
    FROM jobs_pre_worldbook_compact_migration;
    DROP TABLE jobs_pre_worldbook_compact_migration;
  `);
}

function dropTagTablesIfExist(db: Database.Database): void {
  db.exec(`DROP TABLE IF EXISTS tag_index; DROP TABLE IF EXISTS tags;`);
}

/** Decad archive blocks are retired — drop rows and orphan archive jobs on every open (idempotent). */
function purgeLegacyArchives(db: Database.Database): void {
  db.exec(`
    UPDATE jobs SET status = 'cancelled', finished_at = datetime('now'),
      error = COALESCE(error, 'legacy archive purge')
    WHERE job_type IN ('archive', 'archive-name') AND status IN ('pending', 'running');
    DELETE FROM jobs WHERE job_type IN ('archive', 'archive-name');
    DELETE FROM archive_member;
    DELETE FROM archive;
  `);
}

export function closeStoryDb(storyId: string): void {
  const db = openStoryDbs.get(storyId);
  if (!db) return;
  db.close();
  openStoryDbs.delete(storyId);
}

/**
 * `skipRecovery` exists for read-only diagnostic callers (the MCP dev server, ad-hoc inspection
 * scripts) that open a fresh, uncached connection and close it again after one read (see
 * dev-server.ts's withStoryDb) — every such call used to run recoverStaleJobs unconditionally,
 * which can reset a job that's genuinely still executing (claimed 'running' in the owning main
 * server process) back to 'pending', causing scanStory to reclaim and re-dispatch it while the
 * original execution is still in flight. Found live 2026-07-03 while testing Horde jobs (whose
 * long wall-clock 'running' window made the race easy to trigger and observe), but it was never
 * Horde-specific — a Featherless job's horde_request_id is always null, so recoverStaleJobs'
 * exclusion for in-flight Horde jobs never protected Featherless jobs from this at all. Only the
 * one process actually claiming and executing jobs should ever run real recovery.
 */
export function getStoryDb(storyId: string, options?: { skipRecovery?: boolean }): Database.Database {
  const existing = openStoryDbs.get(storyId);
  if (existing) return existing;

  mkdirSync(STORIES_DIR, { recursive: true });
  const db = new Database(storyDbPath(storyId));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrateWorldbookEntryShape(db);
  migrateJobTypeCheck(db);
  migrateJobTypeWorldbookCompact(db);
  dropTagTablesIfExist(db);
  db.exec(STORY_SCHEMA_SQL);
  ensureColumn(db, "story_state", "current_page_id", "TEXT REFERENCES page(id)");
  ensureColumn(db, "story_state", "history_cursor_seq", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "story_state", "ooc_session_start_page_id", "TEXT REFERENCES page(id)");
  ensureColumn(db, "jobs", "model", "TEXT");
  ensureColumn(db, "jobs", "token_estimate", "INTEGER");
  ensureColumn(db, "jobs", "input_token_estimate", "INTEGER");
  ensureColumn(db, "jobs", "horde_request_id", "TEXT");
  ensureColumn(db, "jobs", "elapsed_ms", "INTEGER");
  ensureColumn(db, "jobs", "result_summary", "TEXT");
  ensureColumn(db, "archive", "name", "TEXT");
  ensureColumn(db, "text", "compress_metrics", "TEXT");
  ensureColumn(db, "page", "memory_content_stamp", "TEXT");
  ensureColumn(db, "jobs", "target_story_to_date_id", "TEXT REFERENCES story_to_date_segment(id)");
  ensureColumn(db, "story_to_date_segment", "name", "TEXT");
  finishJobTypeCheckMigration(db);
  finishJobTypeWorldbookCompactMigration(db);
  purgeLegacyArchives(db);
  backfillSelectedForks(db);
  backfillMemoryContentStamps(db);
  if (!options?.skipRecovery) recoverStaleJobs(db);
  openStoryDbs.set(storyId, db);
  return db;
}
