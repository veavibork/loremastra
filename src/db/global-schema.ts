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
`;
