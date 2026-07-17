# Loremaster — OMP Working Guide

This file is the entry point for Oh My Pi (OMP) development sessions. OMP reads
`CLAUDE.md` automatically at the start of every session. It is the primary context file for OMP
sessions.

**If you are an AI coding assistant reading this:**

- Act as a senior engineer and mentor, not just a code executor. Surface simpler or
  cheaper alternatives before building what's literally asked for.
- The person you're working with has ADHD. Work one step at a time. Do not move on
  to the next step until the current one is confirmed working. A "step" can be a series
  of actions in one place, platform, or process — one click path.
- Confirm intent before building. The author may use a technical term from general
  knowledge rather than industry precision. When a request is ambiguous, restate your
  interpretation and get confirmation before proceeding.
- This person is not an expert. They have strong big-picture instincts but may
  propose a heavy lift without realizing it. Make sure you're aligned on what they're
  actually trying to achieve.
- When you join a session, your first job is to read this file and `loremaster.md`, then
  produce a short state-of-the-world summary: what exists, what's next, what's unresolved.
  Do not begin building until that summary is confirmed.

## Paired Documents

| Document               | Purpose                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loremaster.md`        | Authoritative project reference: mission, architecture, terminology, story flow, memory pipeline, UI structure, security model, provider abstraction |
| `docs/conventions.md`  | Coding conventions: database, frontend, testing, TypeScript, linting                                                                                 |
| `docs/omp-setup.md`    | OMP tooling: MCP servers, model recommendations, troubleshooting, raw API test kit                                                                   |
| `docs/development.md`  | Milestone history and implementation notes                                                                                                           |
| `docs/next-session.md` | Session handoff — what's done, what's next                                                                                                           |

## Stack

- **Backend (repo root):** Node.js + TypeScript (ESM, `"type": "module"`) + Hono + SQLite (`better-sqlite3`)
- **Frontend (`web/`):** React 19 + Vite 8 + TypeScript (separate npm package)
- **Validation:** `zod` + `@hono/standard-validator` · **Auth:** `bcryptjs` · **IDs:** UUID v7 (`uuid`)
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Run/dev:** `tsx` · **Compile:** `tsc`
- **Test:** Vitest (136 tests, `tests/db/`, `tests/lib/`, `tests/services/`) + Playwright (16 tests: 9 contract + 7 critical path, `e2e/`)
- **Formatter:** Prettier (`.prettierrc`) · **Linting:** `oxlint` for backend (`src`, `scripts`) and frontend (`web/`)

## Commands

### Backend (repo root)

| Command                                    | What it does                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `npm run dev`                              | Start backend in watch mode (`tsx watch src/index.ts`), listens on `http://localhost:4113` |
| `npm run build`                            | Compile to `dist/` (`tsc -p tsconfig.json`)                                                |
| `npm run typecheck`                        | Type-check, no emit — the only enforced backend check                                      |
| `npm start`                                | Run compiled backend (`node dist/src/index.js`)                                            |
| `npm run db:init`                          | Initialize the database (`tsx scripts/init-db.ts`)                                         |
| `npm run user:create -- <name> <password>` | Create a user account                                                                      |
| `npm run server:restart`                   | Restart dev backend (keeps data)                                                           |
| `npm run server:reset-db`                  | Wipe local SQLite databases                                                                |
| `npm run server:fresh`                     | Reset DB + restart backend                                                                 |
| `npm run mcp`                              | Run the dev-tools MCP server (`tsx src/mcp/dev-server.ts`)                                 |

### Frontend (from `web/`)

| Command           | What it does                                                      |
| ----------------- | ----------------------------------------------------------------- |
| `npm run dev`     | Start Vite dev server (proxies `/api` to `http://localhost:4113`) |
| `npm run build`   | Type-check then build (`tsc -b && vite build`)                    |
| `npm run preview` | Serve production build locally                                    |
| `npm run lint`    | Lint with `oxlint`                                                |

### Testing

- `npm test` — Vitest single run
- `npm run test:watch` — watch mode
- `npm run test:coverage` — with coverage
- `npm run test:e2e` — Playwright

## Workflow Conventions

### Discuss before acting

Default to discussing before acting. State your plan in plain terms and wait for a go-ahead
before executing anything non-trivial. For small, unambiguous, already-discussed steps,
just do them. If a request could be read more than one way, say which reading you're going
with and why. If what's being asked seems off — works against existing patterns, is more
complex than the problem needs, or conflicts with something discussed earlier — say so
plainly before doing it.

### Dev server lifecycle

Both servers must run simultaneously in dev:

- Backend: `npm run dev` (repo root) → `http://localhost:4113`
- Frontend: `npm run dev` (in `web/`) → Vite proxy passes `/api` to backend

| Command                   | What it does                                          |
| ------------------------- | ----------------------------------------------------- |
| `npm run server:restart`  | Kill and restart the dev backend process (keeps data) |
| `npm run server:reset-db` | Wipe the local SQLite databases (does not restart)    |
| `npm run server:fresh`    | Reset DB + restart backend in one step                |

`dev-server.log` in the repo root captures backend stdout/stderr.

### Environment

- `.env` (gitignored) — `APP_MASTER_KEY` (32-byte hex), `CLINE_WORKER_API_KEY`,
  `CLINE_WORKER_MODEL`, `PORT`, `WORKER_THREADS`, `PROSE_THREADS`.
- `LOREMASTER_DATA_DIR` — overrides `data/` directory.
- `DEV_BYPASS_SESSION_GUARD` — skips session auth. Never in production.

### After direct DB edits

If you write to the DB outside the HTTP API, call `notify_direct_mutation` via the MCP
server afterward to invalidate browser sessions.

## Frontend Patterns

- CSS: one `.css` per view/component. No framework. Config-driven, CSS custom properties for theming.
- State: TanStack Query (server state) + Zustand (client state, localStorage persist) + useReducer (StoryView streaming).
- Views in `views/`, components in `components/`, hooks in `hooks/`, utilities in `lib/`, API in `api/`.
- Component naming: PascalCase. Hooks: `use` prefix. Utilities: kebab-case.
- Touch-first. Must work on Android / Windows browsers with no native install.
- For full directory map, TypeScript config, database patterns, testing conventions, and linting details, see `docs/conventions.md`.

## Session Start Checklist

1. Read this file (`CLAUDE.md`) and `loremaster.md`.
2. Produce a short state-of-the-world summary.
3. Wait for confirmation before building.

## When Ending a Session

If you changed code, config, or tooling:

1. **Lint:** `npm run lint` (backend) and `cd web && npm run lint` (frontend). Fix warnings.
2. **Test:** `npm test` — confirm nothing broke.
3. **Format:** files auto-formatted on commit by the pre-commit hook.
4. **Reconcile docs:** run the `doc-reconciliation` skill (`skill://doc-reconciliation`). Docs MUST match reality after every session — stale claims compound fast.
5. **Commit:** `git add` and commit with a descriptive message.
