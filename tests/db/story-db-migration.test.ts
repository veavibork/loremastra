/**
 * Regression coverage for the story_to_date_segment 'fold' kind migration (2026-08-01).
 *
 * Incident: migrateStoryToDateKindCheck renames story_to_date_segment (the table
 * jobs.target_story_to_date_id foreign-keys INTO) to add 'fold' to its kind CHECK. SQLite
 * unconditionally rewrites jobs' FK clause to follow the rename — confirmed empirically, not
 * gated by legacy_alter_table or foreign_keys=OFF at rename time — so jobs ended up permanently
 * referencing a temporary migration table name once it was dropped, breaking every subsequent
 * getStoryDb call for that story with "FOREIGN KEY constraint failed". Hit live on the VM's
 * actively-stress-tested story on first deploy.
 *
 * These tests exercise the real getStoryDb (not the in-memory createStoryDb helper other db
 * tests use) against real temp files, since the bug is specifically about file-based migration
 * sequencing that an in-memory fresh-schema helper never goes through.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let dataDir: string
let originalDataDir: string | undefined

beforeEach(() => {
  originalDataDir = process.env.LOREMASTER_DATA_DIR
  dataDir = mkdtempSync(path.join(tmpdir(), 'loremaster-migration-test-'))
  process.env.LOREMASTER_DATA_DIR = dataDir
})

afterEach(async () => {
  const { closeStoryDb } = await import('../../src/db/story-db.js')
  closeStoryDb('pre-fold')
  closeStoryDb('already-broken')
  if (originalDataDir === undefined) delete process.env.LOREMASTER_DATA_DIR
  else process.env.LOREMASTER_DATA_DIR = originalDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

describe('story-db fold-kind migration', () => {
  it('migrates a real pre-fold story DB without breaking jobs.target_story_to_date_id', async () => {
    const { storyDbPath, storiesDir } = await import('../../src/db/data-paths.js')
    const { STORY_SCHEMA_SQL } = await import('../../src/db/story-schema.js')
    const fs = await import('node:fs')
    fs.mkdirSync(storiesDir(), { recursive: true })
    const file = storyDbPath('pre-fold')

    // Real pre-migration shape: current schema everywhere except story_to_date_segment.kind's
    // CHECK, which every real pre-existing story file predates.
    const oldSchema = STORY_SCHEMA_SQL.replace(
      "'begins','continues','fold'",
      "'begins','continues'",
    )
    expect(oldSchema).not.toBe(STORY_SCHEMA_SQL)

    const setup = new Database(file)
    setup.pragma('foreign_keys = ON')
    setup.exec(oldSchema)
    setup
      .prepare(`INSERT INTO book (id, created_at, book_type) VALUES ('b1', 'now', 'logbook')`)
      .run()
    setup
      .prepare(
        `INSERT INTO story_to_date_segment (id, created_at, book_id, kind, content, seq) VALUES ('s1', 'now', 'b1', 'begins', 'x', 0)`,
      )
      .run()
    setup
      .prepare(
        `INSERT INTO jobs (id, created_at, target_story_to_date_id, job_type, status) VALUES ('j1', 'now', 's1', 'story-to-date', 'running')`,
      )
      .run()
    setup.close()

    const { getStoryDb } = await import('../../src/db/story-db.js')
    const db = getStoryDb('pre-fold')

    const jobsSchema = (
      db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'jobs'`).get() as { sql: string }
    ).sql
    expect(jobsSchema).toContain('REFERENCES story_to_date_segment(id)')
    expect(jobsSchema).not.toContain('story_to_date_segment_pre_fold_migration')
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE name = 'story_to_date_segment_pre_fold_migration'`,
        )
        .get(),
    ).toBeUndefined()

    const job = db.prepare(`SELECT target_story_to_date_id FROM jobs WHERE id = 'j1'`).get() as {
      target_story_to_date_id: string
    }
    expect(job.target_story_to_date_id).toBe('s1')

    const segment = db.prepare(`SELECT kind FROM story_to_date_segment WHERE id = 's1'`).get() as {
      kind: string
    }
    expect(segment.kind).toBe('begins')

    // Real FK enforcement, not just "doesn't throw at startup".
    expect(() =>
      db
        .prepare(
          `INSERT INTO jobs (id, created_at, target_story_to_date_id, job_type, status) VALUES ('bad', 'now', 'does-not-exist', 'story-to-date', 'pending')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/)
    expect(() =>
      db
        .prepare(
          `INSERT INTO jobs (id, created_at, target_story_to_date_id, job_type, status) VALUES ('good', 'now', 's1', 'story-to-date-fold', 'pending')`,
        )
        .run(),
    ).not.toThrow()
  })

  it('self-heals a story DB left in the broken intermediate state by an earlier failed migration', async () => {
    const { storyDbPath, storiesDir } = await import('../../src/db/data-paths.js')
    const { STORY_SCHEMA_SQL } = await import('../../src/db/story-schema.js')
    const fs = await import('node:fs')
    fs.mkdirSync(storiesDir(), { recursive: true })
    const file = storyDbPath('already-broken')

    // Exact state the incident left on disk: fresh story_to_date_segment (already has the
    // migrated data and the new CHECK), the leftover renamed table still present, and jobs still
    // pointing at that leftover table's name.
    const setup = new Database(file)
    setup.pragma('foreign_keys = OFF')
    setup.exec(STORY_SCHEMA_SQL)
    setup.exec(`
      CREATE TABLE story_to_date_segment_pre_fold_migration (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, book_id TEXT NOT NULL,
        kind TEXT NOT NULL, content TEXT, coverage_through_ic_post INTEGER,
        coverage_page_id TEXT, input_ceiling_ic_post INTEGER, input_ceiling_page_id TEXT,
        seq INTEGER NOT NULL, name TEXT, hidden INTEGER NOT NULL DEFAULT 0, broken INTEGER NOT NULL DEFAULT 0,
        audit_verdict TEXT, audit_missing TEXT, audit_at TEXT
      );
    `)
    setup
      .prepare(`INSERT INTO book (id, created_at, book_type) VALUES ('b1', 'now', 'logbook')`)
      .run()
    setup
      .prepare(
        `INSERT INTO story_to_date_segment (id, created_at, book_id, kind, content, seq) VALUES ('s1', 'now', 'b1', 'begins', 'x', 0)`,
      )
      .run()
    setup
      .prepare(
        `INSERT INTO story_to_date_segment_pre_fold_migration (id, created_at, book_id, kind, content, seq) VALUES ('s1', 'now', 'b1', 'begins', 'x', 0)`,
      )
      .run()
    const realJobsSql = (
      setup.prepare(`SELECT sql FROM sqlite_master WHERE name = 'jobs'`).get() as { sql: string }
    ).sql
    setup.exec(`DROP TABLE jobs`)
    setup.exec(
      realJobsSql.replace(
        'target_story_to_date_id TEXT REFERENCES story_to_date_segment(id)',
        'target_story_to_date_id TEXT REFERENCES "story_to_date_segment_pre_fold_migration"(id)',
      ),
    )
    setup
      .prepare(
        `INSERT INTO jobs (id, created_at, target_story_to_date_id, job_type, status) VALUES ('j1', 'now', 's1', 'story-to-date', 'running')`,
      )
      .run()
    setup.close()

    const { getStoryDb, closeStoryDb } = await import('../../src/db/story-db.js')
    const db = getStoryDb('already-broken')

    const jobsSchema = (
      db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'jobs'`).get() as { sql: string }
    ).sql
    expect(jobsSchema).toContain('REFERENCES story_to_date_segment(id)')
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE name = 'story_to_date_segment_pre_fold_migration'`,
        )
        .get(),
    ).toBeUndefined()

    const job = db
      .prepare(`SELECT target_story_to_date_id, status FROM jobs WHERE id = 'j1'`)
      .get() as {
      target_story_to_date_id: string
      status: string
    }
    expect(job.target_story_to_date_id).toBe('s1') // not silently dropped
    expect(job.status).toBe('pending') // recoverStaleJobs still ran normally afterward

    // Reopening is a clean no-op — nothing left to repair.
    closeStoryDb('already-broken')
    const db2 = getStoryDb('already-broken')
    expect(
      db2.prepare(`SELECT sql FROM sqlite_master WHERE name = 'jobs'`).get() as { sql: string },
    ).toMatchObject({ sql: expect.stringContaining('REFERENCES story_to_date_segment(id)') })
  })
})
