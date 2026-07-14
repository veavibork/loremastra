# Repository Guidelines

## Project Overview

Loremaster is a private, long-form RP platform for a small group of trusted users. Backend is Hono + better-sqlite3; frontend is React 19 + Vite. Inference via Featherless (primary) and AI Horde (secondary) with ranked-choice model fallback. Memory model: rolling `[STORY TO DATE]` editor recaps + verbose recent posts (per-post compression is retired).

## Architecture & Data Flow

Monorepo: `src/` (backend, port 4113) and `web/` (frontend, port 5173). Vite dev proxy forwards API calls to Hono.

Request flow: browser → `sessionGuard` middleware (single-active-session enforcement on all HTTP) → route handler (Zod validation) → service layer (business logic) → DB stores or queue dispatch → inference providers.

Background work runs through a job queue (`src/queue/dispatch.ts`): a 500ms scan loop claims jobs by priority (prose > story-to-date > fold > worldbook-compact > naming). Concurrency is governed by per-model slot costs, not fixed lanes — slot costs naturally enforce parallelism limits.

## Key Directories

- `src/routes/` — HTTP handlers. `stories/` is a sub-router mounting posts, messages, worldbook, segments, position, fork, context, jobs.
- `src/db/` — SQLite stores (one `*-store.ts` per entity) + schema + connection caching. Two-tier: `global.sqlite` (users, sessions, configs) vs per-story `data/stories/<id>.sqlite`.
- `src/services/` — Business logic. Subdirs: `story-to-date/` (engine, worker, fold-worker), `worldbook/` (assembly, compact, extraction), `context/` (manifest, invalidation).
- `src/queue/` — Dispatch loop, slots, executors (one per job type), cancel, job-events.
- `src/inference/` — Provider integrations (featherless.ts, horde.ts), telemetry, reasoning-stream.
- `web/src/` — `views/` (top-level), `components/`, `hooks/` (TanStack Query), `api/` (per-domain modules + types), `store.ts` (Zustand).

## Development Commands

```bash
npm install && cd web && npm install   # Install both packages
npm run dev                             # Backend dev (tsx watch, port 4113)
cd web && npm run dev                   # Frontend dev (Vite, port 5173)
npm run typecheck                       # Backend tsc --noEmit (root tsconfig.json includes src + scripts)
cd web && npx tsc --noEmit -p tsconfig.app.json  # Frontend typecheck (web/tsconfig.json has "files":[] + references, checks nothing without -p)
npm test                                # Vitest
npm run test:e2e                        # Playwright (auto-starts both servers)
npm run lint                            # oxlint (backend)
npm run db:init                         # Initialize database
npm run user:create -- <name> <password>
```

Before committing: `npm run lint && npm test`. Pre-commit hook auto-formats with Prettier.

## Code Conventions & Common Patterns

**Formatting:** Prettier — no semicolons, single quotes, trailing commas, 2-space indent, 100 width.

**Backend imports:** `NodeNext` module resolution — all relative imports need `.js` extension (`import { foo } from './bar.js'`).

**Route pattern:** Zod schema → `sValidator('json', schema, validationHook)` → handler. Route params are `string | undefined` — non-null assertion (`c.req.param('id')!`) is required when passing to typed functions. `c.json(body, status)` needs a literal status union (`400 | 404`), not `number`. Ownership checks are done once via middleware on `/:id` and `/:id/*`, not repeated per handler.

**DB pattern:** Synchronous better-sqlite3 — no async/await. No migration framework: `ensureColumn(db, table, column, ddl)` tries `ALTER TABLE ADD COLUMN` and swallows "duplicate column" errors; table-rename technique for CHECK constraint changes. UUIDs (v7) for all PKs. Stores take a `Database` handle — they never open connections. Read-only diagnostic callers pass `{ skipRecovery: true }` to `getStoryDb()`.

**Service/executor pattern:** Services contain business logic and are called from routes. Job executors (`src/queue/executors/`) are called from the dispatch loop — each executor handles one `JobType`. Executors acquire/release concurrency slots, publish progress/done/error events via `job-events.ts`, and support cancellation via `AbortController`.

**Inference pattern:** `AgentProfile` carries model, temperature, sampler params, `concurrencyCost`, and ranked `fallbackModels`. `withModelFallback` tries fallbacks in order on failure. Telemetry writes are wrapped in try/catch — must never break the inference call.

**Frontend state:** Three layers — TanStack Query (server state), Zustand with `persist` middleware (client state, single `loremaster.ui` localStorage key), `useReducer` (StoryView streaming state machine). One-time migration from old localStorage keys runs on first load.

**Naming:** PascalCase components, `use` prefix hooks, kebab-case utilities. One `.css` per view/component. CSS custom properties for theming.

## Runtime/Tooling Preferences

- **Runtime:** Node.js (not Bun). `tsx` for dev, `tsc` for build.
- **Package manager:** npm.
- **Linter:** oxlint (not ESLint).
- **Env:** `.env` loaded via `process.loadEnvFile()`. `APP_MASTER_KEY` (32-byte hex) encrypts per-user API keys. Provider keys are per-user (Agents tab), not in `.env`.

## Testing & QA

- **Vitest:** `tests/db/` (stores), `tests/lib/` (pure logic), `tests/services/` (service smoke). Config injects test `APP_MASTER_KEY`.
- **Playwright:** `e2e/` — Chromium only, auto-starts both servers with `DEV_BYPASS_SESSION_GUARD=true`.
- **Scripts:** `scripts/` — `test-` prefix (smoke), `probe-` (provider experiments), `story-to-date-*` (memory pipeline). Run with `npx tsx`. Pass `{ skipRecovery: true }` to `getStoryDb()` in scripts that touch the DB.
