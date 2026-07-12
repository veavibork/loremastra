# Loremaster — OMP Working Guide

This file is the entry point for Oh My Pi (OMP) development sessions. OMP reads
`CLAUDE.md` automatically at the start of every session. It is the primary context file for OMP
sessions. Cline rules remain in `.clinerules/` and `docs/cline-setup.md`; OMP ignores `.clinerules/`.

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

| Document              | Purpose                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loremaster.md`       | Authoritative project reference: mission, architecture, terminology, story flow, memory pipeline, UI structure, security model, provider abstraction |
| `docs/omp-setup.md`   | OMP-specific tooling reference, model recommendations, and the Cline-to-OMP migration notes                                                          |
| `docs/cline-setup.md` | Cline-specific tooling reference (kept for reference; superseded by this document for OMP sessions)                                                  |
| `.clinerules/`        | Cline rules directory (kept for Cline sessions; ignored by OMP)                                                                                      |

## Stack

- **Backend (repo root):** Node.js + TypeScript (ESM, `"type": "module"`) + Hono + SQLite (`better-sqlite3`)
- **Frontend (`web/`):** React 19 + Vite 8 + TypeScript (separate npm package)
- **Validation:** `zod` · **Auth:** `bcryptjs` · **IDs:** UUID v7 (`uuid`)
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Run/dev:** `tsx` · **Compile:** `tsc`
- **No test framework** — standalone `tsx` scripts in `scripts/`
- **No formatter** — no Prettier; do not introduce one without a decision
- **Linting:** `oxlint` for frontend only (`web/.oxlintrc.json`)

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

There is **no `npm test` command** and no test-runner framework. Run specific `tsx` scripts:

```bash
npx tsx scripts/test-memory-pipeline-smoke.ts
```

Script prefixes: `test-` (smoke/integration), `probe-` (diagnostic), `debug-` (debug tools),
`inspect-`/`check-` (read-only inspection), `story-to-date-*` (memory experiments), `vm-*`
(VM-sync diagnostics).

## Database Patterns

### Two-tier model

- **`data/global.sqlite`** — cross-story tables: users, sessions, agent configs, model configs,
  layout configs, settings spaces. Accessed via `getGlobalDb()`.
- **Per-story** (`data/stories/<storyId>.sqlite`) — story-scoped data: pages, texts, worldbook
  entries, jobs, story-to-date segments. Accessed via `getStoryDb(storyId)`.

### No migration framework

- **`ensureColumn(db, table, column, ddl)`** — tries `ALTER TABLE ... ADD COLUMN`, swallows
  "duplicate column" errors. Safe to call on every open.
- **Table rename technique** — for CHECK constraint changes, see `migrateJobTypeCheck`.
- **Schema sniffing** — `SELECT sql FROM sqlite_master WHERE name = 'table'`.

### Key conventions

- UUIDs (v7) for all primary keys — never sequential integers.
- Pragmas: `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`.
- Read-only diagnostic callers must pass `{ skipRecovery: true }` to `getStoryDb()`.
- One `*-store.ts` per entity in `src/db/`. Stores take a `Database` handle.
- Per-post compression (`gen_extract`) and decad archives are retired (2026-07-04).

## Workflow Conventions

### Discuss before acting

Default to discussing before acting. State your plan in plain terms and wait for a go-ahead
before executing anything non-trivial. For small, unambiguous, already-discussed steps,
just do them.

### Dev server lifecycle

Both servers must run simultaneously in dev:

- Backend: `npm run dev` (repo root) → `http://localhost:4113`
- Frontend: `npm run dev` (in `web/`) → Vite proxy passes `/api` to backend

### Environment

- `.env` (gitignored) — `APP_MASTER_KEY` (32-byte hex), `CLINE_WORKER_API_KEY`,
  `CLINE_WORKER_MODEL`, `PORT`, `WORKER_THREADS`, `PROSE_THREADS`.
- `LOREMASTER_DATA_DIR` — overrides `data/` directory.
- `DEV_BYPASS_SESSION_GUARD` — skips session auth. Never in production.

### After direct DB edits

If you write to the DB outside the HTTP API, call `notify_direct_mutation` via the MCP
server afterward to invalidate browser sessions.

## MCP Servers

Registered in `.mcp.json`:

| Server           | Source                    | Purpose                                                                                   |
| ---------------- | ------------------------- | ----------------------------------------------------------------------------------------- |
| `loremaster-dev` | `src/mcp/dev-server.ts`   | Live state inspection: stories, worldbook, queue, logs, memory, prompt preview            |
| `context7`       | `@upstash/context7-mcp`   | Up-to-date library docs (Hono, React 19, better-sqlite3, MCP SDK)                         |
| `cline-worker`   | `src/mcp/cline-worker.ts` | Cheap 1-slot Featherless model for code lookup / Q&A (`ask_worker`, `list_worker_models`) |

## OMP Tool Mapping

| Concern           | Cline                        | OMP                                        |
| ----------------- | ---------------------------- | ------------------------------------------ |
| Context injection | `.clinerules/` auto-injected | `CLAUDE.md` auto-read (this file)          |
| File read         | `read_file`                  | `read`                                     |
| File write        | `write_to_file`              | `write`                                    |
| File edit         | `replace_in_file`            | `edit`                                     |
| Search content    | `search_files`               | `grep` (Rust regex)                        |
| Find files        | `search_files`               | `glob`                                     |
| Shell commands    | `execute_command`            | `bash`                                     |
| Code intelligence | N/A                          | `lsp`                                      |
| AST search        | N/A                          | `ast_grep` / `ast_edit`                    |
| Sub-agents        | N/A                          | `task`                                     |
| Worker model      | `ask_worker` MCP tool        | Same MCP tool, or OMP `completion`/`agent` |

## Frontend Patterns

- Views: `*View.tsx` files in `web/src/`.
- CSS: one `.css` per view/component. No framework. Config-driven, relative units.
- No state management library — React state + fetch. Claim/reclaim session model.
- Component naming: PascalCase. Hooks: `use` prefix. Utilities: kebab-case.
- Touch-first. Must work on Android / Windows browsers with no native install.

## First-Time Setup

1. Install dependencies:
   ```bash
   npm install
   cd web && npm install
   ```
2. Copy `.env.example` to `.env`, set `APP_MASTER_KEY`:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
3. Initialize the database:
   ```bash
   npm run db:init
   ```
4. Create a user:
   ```bash
   npm run user:create -- <name> <password>
   ```
5. Start backend: `npm run dev`
6. Start frontend: `cd web && npm run dev`
7. Verify MCP servers are available (loremaster-dev, context7, cline-worker).

## Session Start Checklist

1. Read this file (`CLAUDE.md`) and `loremaster.md`.
2. Produce a short state-of-the-world summary.
3. Wait for confirmation before building.

## Featherless + OMP Model Notes

Empirically confirmed for this project with the raw API kit in `src/inference/schema/`:

- **GLM-5.2 (`zai-org/GLM-5.2`)**: intermittent XML tool-call corruption through OMP.
  Once it begins, the session degrades and does not recover. Raw API tests are clean.
  **Not recommended** for OMP-driven development here.
- **Kimi-K2.7-Code (`moonshotai/Kimi-K2.7-Code`)**: clean single and multi-tool calls;
  finishes reliably within ~65s. Reasoning is moderate (~400 chars). Costs 4 slots.
  **Recommended main model for OMP coding work**.
- **DeepSeek V4 Pro (`deepseek-ai/DeepSeek-V4-Pro`)**: clean on short multi-tool calls,
  but long tool calls can enter very long reasoning drafts and timeout/wait (>280s for
  a ~100-line code write). It is the app's capable **prose workhorse** for Author/narration
  — use it there via the Agents tab, not as the main OMP session model. Costs 4 slots.

If you use the cheap worker MCP server (`cline-worker`), keep it on a small 1-slot model
(e.g., `NousResearch/Hermes-3-Llama-3.1-8B`) so it does not consume workhorse slots.

## GLM-5.2 Raw API Test Kit

`src/inference/schema/` contains Darkness-bamboo's raw API verification toolkit:
`req-toolcall.json`, `req-multitool.json`, `parse.py`, and `README.md`. Use it to verify
new models empirically before relying on them in OMP.
