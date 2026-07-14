# Coding Conventions

Pulled on demand when working in a specific area. For stack summary, commands, and workflow,
see `CLAUDE.md`. For project architecture and terminology, see `loremaster.md`.

---

## Database

LM uses SQLite via `better-sqlite3` (synchronous API, no async/await needed for DB calls).
There is **no migration framework**. Schema changes use lightweight ad-hoc patterns.

### Two-tier model

- **`data/global.sqlite`** — cross-story tables: users, sessions, agent configs, model configs,
  layout configs, settings spaces. Accessed via `getGlobalDb()`.
- **Per-story** (`data/stories/<storyId>.sqlite`) — story-scoped data: pages, texts, worldbook
  entries, jobs, story-to-date segments. Accessed via `getStoryDb(storyId)`.
- `data-paths.ts` resolves all paths. `LOREMASTER_DATA_DIR` env var overrides the base `data/` directory.
- Connections are cached in a `Map` — call `closeStoryDb(storyId)` when done (especially in
  short-lived diagnostic callers).

### No-migration schema evolution

- **`ensureColumn(db, table, column, ddl)`** — tries `ALTER TABLE ... ADD COLUMN`, swallows
  "duplicate column" errors. Safe to call on every open.
- **Table rename technique** — for CHECK constraint changes (e.g. adding new `job_type`
  values), rename the old table, let `SCHEMA_SQL` create a fresh one, copy rows back, drop
  the renamed copy. See `migrateJobTypeCheck` / `finishJobTypeCheckMigration` in `story-db.ts`.
- **Schema sniffing** — `SELECT sql FROM sqlite_master WHERE name = 'table'` to detect
  whether a migration has already run, instead of a version counter.

### Key conventions

- UUIDs (v7) for all primary keys — never sequential integers. Use `src/lib/uuid.ts` for generation.
- Pragmas: every connection sets `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`.
- Read-only diagnostic callers must pass `{ skipRecovery: true }` to `getStoryDb()`.
- One `*-store.ts` per entity in `src/db/`. Stores take a `Database` handle, do not open
  connections themselves; callers pass the db handle.
- `content_hash` on `page` is a SHA-256 fingerprint of normalized `gen_package`. Used for
  invalidation diagnostics, not compression triggers (compression is retired).
- Per-post compression (`gen_extract`) and decad archives are retired (2026-07-04).
  `gen_extract` columns and `archive`/`archive_member` tables were removed. Do not
  reintroduce without an explicit design decision.

---

## Frontend

- CSS: one `.css` per view/component. No framework. Config-driven, CSS custom properties for
  theming (`--entry-font-size`, `--danger`, `--surface`, etc. defined in `index.css`).
- State: TanStack Query (server state) + Zustand (client state, `persist` middleware, single
  `loremaster.ui` localStorage key) + useReducer (StoryView streaming state machine).
- Component naming: PascalCase. Hooks: `use` prefix. Utilities: kebab-case.
- Touch-first. Must work on Android and Windows browsers without native app installation.

### Directory map

Repo root:

- `src/` — backend source
- `web/` — frontend (React + Vite), its own package with `src/`, `public/`, `index.html`, `vite.config.ts`
- `scripts/` — one-off/dev/diagnostic scripts (DB init, user creation, dev server management, smoke tests, probes)
- `docs/` — project documentation
- `data/` — local runtime data (SQLite databases)
- `dist/` — compiled backend output (build artifact)
- `loremaster.md` — project mission, architecture, and terminology reference
- `README.md` — setup and command reference

Backend `src/`:

- `index.ts` — server entrypoint (Hono app, listens on port 4113)
- `config.ts`, `prompts.ts` — top-level configuration modules
- `lib/` — shared utilities (`time.ts`, `uuid.ts`, `crypto.ts`, `validation-hook.ts`, `errors.ts`)
- `routes/` — HTTP route handlers (`stories.ts`, `agents.ts`, `account.ts`, `sessions.ts`, `settings-spaces.ts`, `layout.ts`, `prompts.ts`, `client-errors.ts`)
- `db/` — SQLite stores and schema (one `*-store.ts` per entity, plus `global-schema.ts`, `story-schema.ts`, `global-db.ts`, `story-db.ts`)
- `services/` — business logic (story-to-date, worldbook, story transition, context invalidation, worldbook assembly, history, post-index, fork, layout)
- `queue/` — job queue, concurrency, worker-lane logic
- `inference/` — inference-provider integrations (Featherless, AI Horde, reasoning-stream, outbound logging)
- `middleware/` — Hono middleware (`session-guard.ts`)
- `mcp/` — dev-tools MCP server (`dev-server.ts`, `single-instance.ts`)
- `defaults/` — bundled data files (`featherless-tag-ratings.json`, `hf-model-tags.json`, `global-css.ts`)

Frontend `web/src/`:

- `views/` — top-level views (`*View.tsx`), each with matching `.css`
- `components/` — reusable components (`Nav`, `ClaimGate`, `StoryLog`, etc.)
- `hooks/` — TanStack Query hooks and custom hooks
- `lib/` — utilities (`format-time`, `layoutUtils`, `toast`, `error-capture`, etc.)
- `api/` — API modules (one per resource domain) + `client.ts` + `types.ts`
- `store.ts` — Zustand store (client state with localStorage persistence)

### TypeScript config

- Backend `tsconfig.json`: target ES2022, `NodeNext` modules, `strict: true`, includes `src`
  and `scripts`, emits to `dist/`.
- Frontend uses project references: `web/tsconfig.json` → `tsconfig.app.json` (app, `src/`) +
  `tsconfig.node.json` (Vite config). App config is `strict`-adjacent with `noUnusedLocals`,
  `noUnusedParameters`, `noFallthroughCasesInSwitch`, bundler module resolution, `noEmit`.
- **Typecheck gotcha:** Root `tsconfig.json` has `"files": []` with only project references —
  `npx tsc --noEmit` checks nothing. Use `npx tsc --noEmit -p tsconfig.app.json` for frontend
  typechecking.

---

## Testing

### Test runners

**Unit / integration:** Vitest (`vitest.config.ts`). Tests in `tests/db/` (store tests),
`tests/lib/` (pure-logic tests), and `tests/services/` (service-level smoke tests including
pipeline smoke).

- `npm test` — single run
- `npm run test:watch` — watch mode
- `npm run test:coverage` — with coverage

**E2E:** Playwright (`playwright.config.ts`). Tests in `e2e/`.

- `npm run test:e2e`

### Smoke / diagnostic scripts

Standalone TypeScript scripts in `scripts/`, run individually with `tsx`:

| Prefix                | Purpose                                                         |
| --------------------- | --------------------------------------------------------------- |
| `test-`               | Smoke/integration checks — verify a subsystem works end-to-end  |
| `probe-`              | Diagnostic experiments — explore an API/provider behavior       |
| `debug-`              | Debugging tools — inspect specific state or trace a bug         |
| `inspect-` / `check-` | Read-only inspection of DB or runtime state                     |
| `story-to-date-*`     | Memory pipeline experiments and diagnostics                     |
| `vm-*`                | VM-sync diagnostics (`.cjs`/`.mjs` variants for standalone use) |

Key scripts: `test-memory-pipeline-smoke.ts` (full pipeline integration),
`test-content-store.ts` (content store CRUD), `test-memory-pipeline-http.ts` (pipeline via
HTTP), `test-post-index-smoke.ts` (tag indexing), `test-role-suggestions.ts` (role logic).

### Before running scripts that touch the DB

Pass `{ skipRecovery: true }` to `getStoryDb()` to avoid resetting in-flight jobs. Consider
setting `LOREMASTER_DATA_DIR` to a temp directory if the script might corrupt data.

---

## Linting and formatting

- **Frontend:** oxlint, configured in `web/.oxlintrc.json` (plugins: `react`, `typescript`,
  `oxc`; rules: `react/rules-of-hooks: error`, `react/only-export-components: warn`). Run with
  `npm run lint` from `web/`.
- **Backend:** oxlint, configured in `.oxlintrc.json` (plugins: `typescript`, `oxc`). Run with
  `npm run lint` from repo root. The only other enforced check is `npm run typecheck`.
- **Formatting:** Prettier (`.prettierrc`, `.prettierignore`), run with `npm run format` from
  root or `web/`. A `lint-staged` pre-commit hook (via `simple-git-hooks`) auto-formats staged
  `*.{ts,tsx,js,jsx,json,css,md}` files on commit.
- **Before committing:** run `npm run lint && npm test`. Lint and tests are manual by design
  (not fast enough for a commit hook).
