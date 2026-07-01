/**
 * page.selected_text_id intentionally has no FK constraint: it points at a row
 * in `text`, which is defined after `page` because `text.page_id` points the
 * other way. It's still indexed for lookups; integrity is enforced at the
 * application layer.
 */
export const STORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS book (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  parent_book_id TEXT REFERENCES book(id),
  book_type TEXT NOT NULL CHECK (book_type IN ('user','game','worldbook','sourcebook','logbook')),
  hidden INTEGER NOT NULL DEFAULT 0,
  broken INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS page (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  book_id TEXT NOT NULL REFERENCES book(id),
  prev_page_id TEXT REFERENCES page(id),
  selected_fork_page_id TEXT REFERENCES page(id),
  selected_text_id TEXT,
  select_time TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  broken INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_page_book ON page(book_id);
CREATE INDEX IF NOT EXISTS idx_page_prev ON page(prev_page_id);
CREATE INDEX IF NOT EXISTS idx_page_selected_text ON page(selected_text_id);

CREATE TABLE IF NOT EXISTS text (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  page_id TEXT NOT NULL REFERENCES page(id),
  prior_text_id TEXT REFERENCES text(id),
  role TEXT NOT NULL CHECK (role IN ('user','agent','system')),
  source_page_id TEXT REFERENCES page(id),
  hidden INTEGER NOT NULL DEFAULT 0,
  broken INTEGER NOT NULL DEFAULT 0,
  gen_request TEXT,
  gen_package TEXT,
  gen_metrics TEXT,
  gen_extract TEXT
);
CREATE INDEX IF NOT EXISTS idx_text_page ON text(page_id);
CREATE INDEX IF NOT EXISTS idx_text_prior ON text(prior_text_id);

CREATE TABLE IF NOT EXISTS archive (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  book_id TEXT NOT NULL REFERENCES book(id),
  start_page_id TEXT NOT NULL REFERENCES page(id),
  end_page_id TEXT NOT NULL REFERENCES page(id),
  summary TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  broken INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_archive_book ON archive(book_id);

CREATE TABLE IF NOT EXISTS archive_member (
  archive_id TEXT NOT NULL REFERENCES archive(id),
  text_id TEXT NOT NULL REFERENCES text(id),
  is_owner INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (archive_id, text_id)
);
CREATE INDEX IF NOT EXISTS idx_archive_member_text ON archive_member(text_id);

-- One row per worldbook entry, keyed to its page. Field content lives in
-- text.gen_package (JSON), so editing an entry is just createRetryText --
-- the same write-once-per-version primitive posts already use. That's what
-- gives worldbook entries version history/rollback for free (loremaster.md's
-- "Worldbook Versioning" section) without a second versioning mechanism.
-- Singleton enforcement (one Setting, one Register, one PC) is a DB-level
-- invariant via partial unique indexes, not just app-layer discipline.
CREATE TABLE IF NOT EXISTS worldbook_entry (
  page_id TEXT PRIMARY KEY REFERENCES page(id),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('setting','register','location','creature','faction','character')),
  is_pc INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_worldbook_singleton_setting ON worldbook_entry(entry_type) WHERE entry_type = 'setting';
CREATE UNIQUE INDEX IF NOT EXISTS idx_worldbook_singleton_register ON worldbook_entry(entry_type) WHERE entry_type = 'register';
CREATE UNIQUE INDEX IF NOT EXISTS idx_worldbook_singleton_pc ON worldbook_entry(is_pc) WHERE is_pc = 1;

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES book(id),
  name TEXT NOT NULL,
  worldbook_page_id TEXT REFERENCES page(id),
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (book_id, name)
);
CREATE INDEX IF NOT EXISTS idx_tags_book ON tags(book_id);

CREATE TABLE IF NOT EXISTS tag_index (
  tag_id TEXT NOT NULL REFERENCES tags(id),
  text_id TEXT NOT NULL REFERENCES text(id),
  matched_at TEXT NOT NULL,
  PRIMARY KEY (tag_id, text_id)
);
CREATE INDEX IF NOT EXISTS idx_tag_index_text ON tag_index(text_id);

-- Single-row table (id=1 enforced) tracking where this story is in the
-- Setup -> Kickoff -> Story flow (loremaster.md's Story Flow section).
-- kickoff_page_id identifies the opening-post page once kickoff starts, so
-- guided-retry/approve/back-to-setup all know which page they're acting on
-- without guessing from log position.
-- current_page_id is the Undo/Redo/Rewind cursor (loremaster.md's Post Controls
-- section): NULL means "at the head" (resolved dynamically via findHeadPageId),
-- non-null means the user has stepped backward/forward to a specific page.
-- Non-destructive — moving it never touches page/text rows, and a new post
-- created while it's non-null attaches there, creating a sibling fork rather
-- than overwriting anything.
CREATE TABLE IF NOT EXISTS story_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  phase TEXT NOT NULL DEFAULT 'setup' CHECK (phase IN ('setup','kickoff','story')),
  kickoff_page_id TEXT REFERENCES page(id),
  current_page_id TEXT REFERENCES page(id)
);
-- current_page_id deliberately omitted here (see ensureColumn in story-db.ts) so this
-- insert works unchanged against pre-existing story_state tables from before that column
-- existed — SQLite's CREATE TABLE IF NOT EXISTS is a no-op on an existing table regardless
-- of DDL differences, so an old table only gets the column via the ALTER migration.
INSERT OR IGNORE INTO story_state (id, phase, kickoff_page_id) VALUES (1, 'setup', NULL);

-- A job targets exactly one of target_text_id (compress/prose/setup) or
-- target_archive_id (archive) — enforced at the application layer in
-- job-store.ts, not here, since SQLite's CHECK can't easily express "exactly
-- one of these two columns is non-null" alongside the FK constraints.
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  target_text_id TEXT REFERENCES text(id),
  target_archive_id TEXT REFERENCES archive(id),
  job_type TEXT NOT NULL CHECK (job_type IN ('compress','archive','continuity','prose','setup')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','cancelled')),
  priority INTEGER NOT NULL DEFAULT 0,
  slot_cost INTEGER NOT NULL DEFAULT 1,
  started_at TEXT,
  finished_at TEXT,
  error TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_target_text ON jobs(target_text_id);
CREATE INDEX IF NOT EXISTS idx_jobs_target_archive ON jobs(target_archive_id);
`;
