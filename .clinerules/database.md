# Database Patterns

LM uses SQLite via `better-sqlite3` (synchronous API, no async/await needed for DB calls).
There is **no migration framework**. Schema changes use lightweight ad-hoc patterns (below).

## Two-tier database model

- **`global.sqlite`** (`data/global.sqlite`) — cross-story tables: users, sessions, agent
  configs, model configs, layout configs, settings spaces. Accessed via `getGlobalDb()`
  in `src/db/global-db.ts`. Single cached connection per process.
- **Per-story databases** (`data/stories/<storyId>.sqlite`) — all story-scoped data: pages,
  texts, worldbook entries, jobs, story-to-date segments. Accessed via `getStoryDb(storyId)`
  in `src/db/story-db.ts`. Connections are cached in a `Map` and must be closed with
  `closeStoryDb(storyId)` when done (especially in short-lived diagnostic callers).

`data-paths.ts` resolves all paths. `LOREMASTER_DATA_DIR` env var overrides the base
`data/` directory (used for VM-sync experiments).

## No-migration framework — ad-hoc schema evolution

`CREATE TABLE IF NOT EXISTS` doesn't add columns to pre-existing tables. Instead:

- **`ensureColumn(db, table, column, ddl)`** — tries `ALTER TABLE ... ADD COLUMN`, swallows
  "duplicate column" errors. Safe to call on every open. Used in both `global-db.ts` and
  `story-db.ts`.
- **Table rename technique** — for CHECK constraint changes (e.g. adding new `job_type`
  values), rename the old table, let `SCHEMA_SQL` create a fresh one, copy rows back, drop
  the renamed copy. See `migrateJobTypeCheck` / `finishJobTypeCheckMigration` in `story-db.ts`.
- **Schema sniffing** — `SELECT sql FROM sqlite_master WHERE name = 'table'` to detect
  whether a migration has already run, instead of a version counter.

When adding a new column: add it to the schema SQL **and** add an `ensureColumn` call in
the appropriate `*-db.ts` opener. When adding a new `job_type` or CHECK value, use the
table-rename migration pattern.

## Key conventions

- **Primary keys:** UUIDs (v7) everywhere, including user records. Never sequential integer
  IDs. Use `src/uuid.ts` for generation.
- **Pragmas:** every connection sets `journal_mode = WAL`, `foreign_keys = ON`,
  `busy_timeout = 5000`.
- **`skipRecovery: true`** — read-only diagnostic callers (MCP dev server, ad-hoc scripts)
  must pass this to `getStoryDb()` to avoid `recoverStaleJobs` resetting in-flight jobs in
  the main server process.
- **Store files** — one `*-store.ts` per entity in `src/db/`. Each exports typed functions
  that take a `Database` handle and return typed rows. Stores do not open connections
  themselves; callers pass the db handle.
- **Content stamps** — `memory_content_stamp` on `page` is a SHA-256 fingerprint of
  normalized `gen_package`. Used for memory invalidation diagnostics, not for compression
  triggers (compression is retired).

## Retired columns/tables (do not rebuild)

Per-post compression (`gen_extract`) and decad archive blocks (`[EVENT SUMMARY]`) are
retired (2026-07-04). Legacy `archive`/`archive_member` rows and `gen_extract` columns may
exist in old DB files but are purged on open via `purgeLegacyArchives`. Do not reintroduce
without an explicit design decision. See `loremaster.md` for full context.
