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

-- One row per worldbook entry, keyed to its page. Content lives in
-- text.gen_package as a raw freeform string (no structured fields), so
-- editing an entry is just createRetryText -- the same write-once-per-version
-- primitive posts already use. That's what gives worldbook entries version
-- history/rollback for free without a second versioning mechanism. No
-- singleton enforcement -- content/roster/memory entries can repeat freely;
-- CONTENT entries accumulate over a story's life and are read in order.
CREATE TABLE IF NOT EXISTS worldbook_entry (
  page_id TEXT PRIMARY KEY REFERENCES page(id),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('content','roster','memory'))
);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES book(id),
  name TEXT NOT NULL,
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
-- ooc_session_start_page_id deliberately omitted here too (see ensureColumn in
-- story-db.ts) -- it marks where the current post-kickoff OOC "update session"
-- began, so the Editor's context can be scoped to just this session rather than
-- every OOC turn the story has ever had.
-- current_page_id deliberately omitted here (see ensureColumn in story-db.ts) so this
-- insert works unchanged against pre-existing story_state tables from before that column
-- existed — SQLite's CREATE TABLE IF NOT EXISTS is a no-op on an existing table regardless
-- of DDL differences, so an old table only gets the column via the ALTER migration.
INSERT OR IGNORE INTO story_state (id, phase, kickoff_page_id) VALUES (1, 'setup', NULL);

-- The Play tab's unified Undo/Redo stack: one flat, chronological ledger covering both page
-- navigation (send/continue/rewind) and text-version changes (retry/edit), so Undo reverses
-- whatever happened most recently regardless of which kind of action it was. story_state's
-- history_cursor_seq (see ensureColumn in story-db.ts) says how far along this ledger the
-- user currently is; 0 means "before the first event." Creating a new event past the cursor
-- (i.e. doing something new after undoing) prunes anything after the cursor first, the same
-- "orphan, don't destroy" way a new page/text version already silently strands old forks.
CREATE TABLE IF NOT EXISTS history_event (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('page','text')),
  page_id TEXT NOT NULL REFERENCES page(id),
  from_value TEXT,
  to_value TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_history_event_seq ON history_event(seq);

-- A job targets exactly one of target_text_id (compress/prose/setup) or
-- target_archive_id (archive) — enforced at the application layer in
-- job-store.ts, not here, since SQLite's CHECK can't easily express "exactly
-- one of these two columns is non-null" alongside the FK constraints.
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  target_text_id TEXT REFERENCES text(id),
  target_archive_id TEXT REFERENCES archive(id),
  job_type TEXT NOT NULL CHECK (job_type IN ('compress','archive','continuity','prose','setup','setup-worldbook')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','cancelled')),
  priority INTEGER NOT NULL DEFAULT 0,
  slot_cost INTEGER NOT NULL DEFAULT 1,
  started_at TEXT,
  finished_at TEXT,
  error TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  token_estimate INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_target_text ON jobs(target_text_id);
CREATE INDEX IF NOT EXISTS idx_jobs_target_archive ON jobs(target_archive_id);
`;
