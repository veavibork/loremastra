export const GLOBAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_kdf_salt TEXT NOT NULL,
  password_verifier TEXT NOT NULL,
  encrypted_settings TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS layout_configs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_layout_configs_user ON layout_configs(user_id);

-- Generic key-value JSON storage for Settings-tab spaces (Global CSS, Play tab display,
-- refusal-detection phrases) — see src/db/settings-space-store.ts. One row per (space, user),
-- with previous_json_blob holding exactly one prior value for a one-step "revert to last
-- saved" per space. Layout config is NOT stored here — it predates this table and has its
-- own multi-config/active-switching semantics (layout_configs below).
CREATE TABLE IF NOT EXISTS settings_spaces (
  space TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  json_blob TEXT NOT NULL,
  previous_json_blob TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (space, user_id)
);

CREATE TABLE IF NOT EXISTS preference_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  encrypted_settings_json TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_preference_profiles_user ON preference_profiles(user_id);

-- Per-agent model/param overrides (Config > Agents). Falls back to config.ts's hardcoded
-- defaults when a role has no row here — see src/services/agent-config.ts. user_id scoping
-- exists for when real multi-user auth lands; single-default-user for now like everything else.
CREATE TABLE IF NOT EXISTS agent_configs (
  role TEXT PRIMARY KEY CHECK (role IN ('author','worker','editor')),
  user_id TEXT NOT NULL REFERENCES users(id),
  model TEXT NOT NULL,
  temperature REAL NOT NULL,
  response_limit INTEGER NOT NULL,
  context_limit INTEGER NOT NULL,
  fallback_models TEXT,
  updated_at TEXT NOT NULL
);

-- Replaces the one-row-per-role agent_configs table above (kept only as a one-time seed
-- source, see ensureModelConfigsSeeded in src/services/agent-config.ts) with a flat,
-- reorderable list of model call profiles. A "model" is really a configured call profile —
-- the same underlying model id can appear in multiple rows with different params, each
-- independently eligible for different roles via the use_* flags. sort_order is the
-- fallback chain position *within whichever role(s) a row is checked for*: for a given
-- role, getAgentProfile takes every active row with that role's flag set, ordered by
-- sort_order, and treats the first as primary and the rest as ranked fallbacks.
CREATE TABLE IF NOT EXISTS model_configs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  model TEXT NOT NULL,
  temperature REAL NOT NULL DEFAULT 1.0,
  response_limit INTEGER NOT NULL DEFAULT 4096,
  context_limit INTEGER NOT NULL DEFAULT 32000,
  presence_penalty REAL,
  frequency_penalty REAL,
  repetition_penalty REAL,
  top_p REAL,
  top_k INTEGER,
  min_p REAL,
  use_author INTEGER NOT NULL DEFAULT 0,
  use_editor INTEGER NOT NULL DEFAULT 0,
  use_worker INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL,
  success_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_model_configs_user ON model_configs(user_id);

-- One row per (provider, model) = the model's probed format profile AND its probe-queue
-- entry (status column). Model format is a property of the model, not the user, so the key
-- is global; requested_by records whose API key the probe runner should use. Jobs proper
-- live per-story (story-schema.ts) and require a story-scoped target, which a model probe
-- doesn't have — hence this separate global mechanism (src/queue/probe-runner.ts).
-- Re-probing resets status to 'pending' while keeping the last good profile_json until a
-- new probe succeeds, so consumers never lose data mid-probe.
CREATE TABLE IF NOT EXISTS model_format_profiles (
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  requested_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','cancelled')),
  profile_json TEXT,
  probed_at TEXT,
  artifact_dir TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, model_id)
);

CREATE TABLE IF NOT EXISTS stories (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  parent_story_id TEXT REFERENCES stories(id),
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stories_owner ON stories(owner_user_id);

-- Frontend error log fed by web/src/toast.ts whenever a warning/error/critical toast
-- fires — not per-user (single-user tool, this is diagnostic data for spotting patterns
-- and later building friendly-title mappings, see web/src/error-titles.ts once it exists).
CREATE TABLE IF NOT EXISTS client_errors (
  id TEXT PRIMARY KEY,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  url TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_client_errors_created ON client_errors(created_at);
`
