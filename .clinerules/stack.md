# Project Stack & Setup

Loremaster is a private long-form roleplaying platform. It is split into two
separate npm packages in one repo: a backend at the repo root and a frontend
in `web/`. Each has its own `package.json` and `package-lock.json` and must be
installed and run separately.

## Languages, frameworks, package manager

- **Package manager:** npm (both `package-lock.json` files are committed).
- **Backend (repo root):** Node.js + TypeScript (ESM — `"type": "module"`).
  - Web framework: Hono (`hono`, `@hono/node-server`)
  - Database: SQLite via `better-sqlite3`
  - Also uses: `zod` (validation), `bcryptjs`, `uuid`,
    `@modelcontextprotocol/sdk`
  - Run/dev via `tsx`; compile via `tsc`.
- **Frontend (`web/`):** React 19 + Vite 8, TypeScript.
  - Dependencies: `react`, `react-dom`, `json-edit-react`.

## First-time setup

From the repo root (per `README.md`):

1. Install both packages' dependencies:
npm install
cd web && npm install


2. Copy `.env.example` to `.env` and set `APP_MASTER_KEY` (32-byte hex; used to
encrypt per-user API keys at rest). Provider API keys are set per user in the
app's Agents tab, not in `.env`.
3. Initialize the database:
npm run db:init


4. Create a user account (there is no self-serve signup):
npm run user:create -- <name> <password>



## Run / dev / build commands

Backend (run from repo root):

| Command | What it does |
|---|---|
| `npm run dev` | Start backend in watch mode (`tsx watch src/index.ts`). Listens on `http://localhost:4113` (override with `PORT`). |
| `npm run build` | Compile backend TypeScript to `dist/` (`tsc -p tsconfig.json`). |
| `npm start` | Run the compiled backend (`node dist/src/index.js`). |
| `npm run typecheck` | Type-check the backend, no emit (`tsc -p tsconfig.json --noEmit`). |
| `npm run db:init` | Initialize the database (`tsx scripts/init-db.ts`). |
| `npm run user:create -- <name> <password>` | Create a user (`tsx scripts/create-user.ts`). |
| `npm run server:restart` | Restart the dev backend process (`node scripts/dev-restart.mjs`). |
| `npm run server:reset-db` | Reset the local database (`node scripts/dev-reset-db.mjs`). |
| `npm run server:fresh` | Reset DB, then restart backend. |
| `npm run mcp` | Run the dev-tools MCP server (`tsx src/mcp/dev-server.ts`). |

Frontend (run from `web/`):

| Command | What it does |
|---|---|
| `npm run dev` | Start the Vite dev server. It proxies `/api` to `http://localhost:4113`, so the backend must also be running. |
| `npm run build` | Type-check then build (`tsc -b && vite build`). |
| `npm run preview` | Serve the production build locally (`vite preview`). |
| `npm run lint` | Lint the frontend (`oxlint`). |

## Testing

There is **no test-runner framework configured** (no Jest, Vitest, Playwright,
etc.). Automated checks are standalone TypeScript scripts in `scripts/`, run
individually with `tsx`. Examples cited in `README.md`:

npx tsx scripts/test-memory-pipeline-smoke.ts



- Scripts prefixed `test-` (e.g. `test-memory-pipeline-smoke.ts`,
  `test-content-store.ts`) are smoke/integration checks.
- Scripts prefixed `probe-`, `debug-`, `inspect-`, `check-`, and the
  `story-to-date-*` scripts are diagnostic/experiment tools, also run via
  `npx tsx scripts/<name>.ts`.

There is no aggregate `npm test` command — run the specific script you need.

## Linting / formatting

- **Frontend:** oxlint, configured in `web/.oxlintrc.json` (plugins: `react`,
  `typescript`, `oxc`; rules: `react/rules-of-hooks: error`,
  `react/only-export-components: warn`). Run with `npm run lint` from `web/`.
- **Backend:** no linter is configured. The only enforced check is
  `npm run typecheck`.
- **Formatting:** no formatter (e.g. Prettier) is configured in this repo.

## Directory map

Repo root:

- `src/` — backend source
- `web/` — frontend (React + Vite), its own package with `src/`, `public/`,
  `index.html`, `vite.config.ts`
- `scripts/` — one-off/dev/diagnostic scripts (DB init, user creation, dev
  server management, smoke tests, probes, experiments)
- `docs/` — project documentation (see below)
- `data/` — local runtime data (SQLite databases, etc.)
- `dist/` — compiled backend output (build artifact)
- `loremaster.md` — project mission, architecture, and terminology reference
- `README.md` — setup and command reference

Backend `src/`:

- `index.ts` — server entrypoint (Hono app, listens on port 4113)
- `config.ts`, `crypto.ts`, `uuid.ts`, `prompts.ts` — top-level modules
- `routes/` — HTTP route handlers (`stories.ts`, `agents.ts`, `account.ts`,
  `sessions.ts`, `settings-spaces.ts`, `layout.ts`, `prompts.ts`,
  `client-errors.ts`)
- `db/` — SQLite stores and schema definitions (one `*-store.ts` per entity,
  plus `global-schema.ts`, `story-schema.ts`, `global-db.ts`, `story-db.ts`)
- `services/` — business logic (memory/story-to-date, worldbook, archive,
  compression, kickoff, history, etc.)
- `queue/` — job queue, concurrency, and worker-lane logic
- `inference/` — inference-provider integrations (Featherless, AI Horde,
  reasoning-stream, outbound logging)
- `middleware/` — Hono middleware (`session-guard.ts`)
- `mcp/` — dev-tools MCP server (`dev-server.ts`, `single-instance.ts`)
- `data/` — bundled data files (`featherless-tag-ratings.json`,
  `hf-model-tags.json`)
- `experiments/` — experimental code

Frontend `web/src/`:

- `main.tsx` — entrypoint; `App.tsx` — root component
- `*View.tsx` — top-level views (Story, Settings, Logs, Memory, Worldbook,
  Archives, Saves, Agents, Prompts, Queue)
- other `*.tsx`/`.ts` — components and helpers (each view has a matching `.css`)
- `assets/`, `public/` — static assets

## Documentation

- `README.md` — setup, run/build commands, dev scripts, memory-diagnostics
  endpoints, project layout.
- `loremaster.md` — full project reference: mission, architecture, terminology,
  roadmap context, and the MCP tool list.
- `docs/roadmap.md` — high-level backlog (open items only).
- `docs/development.md` — milestone history and implementation notes.
- `docs/gcp-deployment.md` — production deployment.
- `docs/featherless-notes.md`, `docs/reasoning-stream-research.md` — inference
  provider / reasoning-stream notes.
- `docs/story-to-date-experiment.md` — the current memory model.
- There is **no CONTRIBUTING file.** `web/README.md` is the stock
  Vite React+TS template readme (generic, not project-specific).

## TypeScript config notes

- Backend `tsconfig.json`: target ES2022, `NodeNext` modules, `strict: true`,
  includes `src` and `scripts`, emits to `dist/`.
- Frontend uses project references: `web/tsconfig.json` →
  `tsconfig.app.json` (app, `src/`) + `tsconfig.node.json` (Vite config).
  App config is `strict`-adjacent with `noUnusedLocals`, `noUnusedParameters`,
  `noFallthroughCasesInSwitch`, bundler module resolution, `noEmit`.