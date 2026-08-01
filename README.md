# Loremaster

A lightweight, private roleplaying platform for a small number of trusted users, built for
long-form ERP/RP stories. It exists to do a narrow set of things mainstream RP platforms
(SillyTavern, KoboldAI, AI Dungeon, and similar) do poorly — context-window degradation over long
stories, provider inflexibility, and freeform/inconsistent worldbook schemas — rather than to
replicate their full feature set. See [loremaster.md](loremaster.md) for the full project
reference (mission, architecture, terminology, story flow, memory pipeline, security model).

## Stack

- **Backend (repo root):** Node.js + TypeScript (ESM) + [Hono](https://hono.dev/) +
  SQLite (`better-sqlite3`) — validation via `zod`, auth via `bcryptjs`, UUID v7 primary keys
- **Frontend (`web/`):** React 19 + Vite 8 + TypeScript, touch-first, config-driven layout
- **Inference providers:** [Featherless](https://featherless.ai/) (primary, OpenAI-compatible,
  streaming) and [AI Horde](https://aihorde.net/) (secondary, async submit-then-poll) — see
  [docs/providers/](docs/providers/) for empirical provider notes
- **Memory:** rolling `[STORY TO DATE]` Editor-generated recaps replace raw context once a story
  gets long, instead of hard-truncating or relying on the model alone to manage its own context
- **Testing:** Vitest (unit/integration) + Playwright (end-to-end) · **Linting:** oxlint ·
  **Formatting:** Prettier

## Setup

1. Install dependencies:
   ```bash
   npm install
   cd web && npm install
   ```
2. Copy `.env.example` to `.env` and fill in `APP_MASTER_KEY` (32-byte hex — encrypts each user's
   provider API keys at rest; generate with
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). Provider API keys
   themselves are set per-user in the app's Agents tab, not in `.env`.
3. Initialize the database:
   ```bash
   npm run db:init
   ```
4. Create an account (there is no self-serve signup — accounts are operator-provisioned):
   ```bash
   npm run user:create -- <name> <password>
   ```

## Running

Both servers run simultaneously in dev:

```bash
npm run dev            # backend — http://localhost:4113
cd web && npm run dev   # frontend — Vite dev server, proxies /api to the backend
```

## Commands

### Backend (repo root)

| Command                                    | What it does                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `npm run dev`                              | Backend dev server, watch mode (`tsx watch src/index.ts`)                                                          |
| `npm run build`                            | Compile to `dist/` (`tsc`)                                                                                         |
| `npm run typecheck`                        | Type-check, no emit                                                                                                |
| `npm start`                                | Run the compiled backend                                                                                           |
| `npm run db:init`                          | Initialize the database                                                                                            |
| `npm run user:create -- <name> <password>` | Create a user account                                                                                              |
| `npm run server:restart`                   | Restart the dev backend (keeps data)                                                                               |
| `npm run server:reset-db`                  | Wipe local SQLite databases                                                                                        |
| `npm run server:fresh`                     | Reset DB + restart backend                                                                                         |
| `npm run mcp`                              | Dev-tools MCP server — live queue/log/worldbook/prompt introspection for AI coding assistants working on this repo |
| `npm run lint`                             | Lint with oxlint                                                                                                   |
| `npm run format`                           | Format everything with Prettier                                                                                    |
| `npm test`                                 | Run the Vitest suite                                                                                               |
| `npm run test:coverage`                    | Vitest with coverage                                                                                               |
| `npm run test:e2e`                         | Run Playwright end-to-end tests                                                                                    |

### Frontend (from `web/`)

| Command           | What it does                                    |
| ----------------- | ----------------------------------------------- |
| `npm run dev`     | Vite dev server (proxies `/api` to the backend) |
| `npm run build`   | Type-check then build for production            |
| `npm run preview` | Serve the production build locally              |
| `npm run lint`    | Lint with oxlint                                |

## Context diagnostics (dev)

While a story is open, quick health checks against the live memory pipeline:

```text
GET  /api/stories/:id/context/summary
GET  /api/stories/:id/context/manifest
GET  /api/stories/:id/prompt-preview
GET  /api/stories/:id/story-to-date
POST /api/stories/:id/context/backfill
POST /api/stories/:id/context/enqueue
```

Local, no-browser smoke test of the same pipeline: `npx tsx scripts/test-memory-pipeline-smoke.ts`.

## Project layout

- `src/` — backend (routes, services, db stores, queue/job dispatch, provider integrations)
- `web/` — frontend (React views/components/hooks, TanStack Query + Zustand state)
- `scripts/` — one-off/dev scripts (DB init, user creation, dev server management, experiment
  harnesses such as `story-to-date-guidance-ab.ts`)
- `docs/` — working documentation:
  - `docs/conventions.md` — coding conventions (DB, frontend, testing, TypeScript, linting)
  - `docs/omp-setup.md` — AI coding assistant tooling (MCP servers, model recommendations)
  - `docs/development.md` — milestone history and implementation notes
  - `docs/next-session.md` — session handoff, open items
  - `docs/gcp-deployment.md` — production deployment runbook
  - `docs/providers/` — empirical findings against Featherless/AI Horde's real API behavior
    (their published docs don't always match observed behavior — see
    [docs/providers/featherless-notes.md](docs/providers/featherless-notes.md))
- `loremaster.md` — the authoritative project reference (mission, architecture, terminology, story
  flow, memory pipeline, UI structure, security model, provider abstraction)
- `CLAUDE.md` — entry point and working guide for AI-assisted development sessions on this repo

## Current state

Phase 1 (single-user-experience-complete, multi-user-and-second-provider milestone shipped) is in
production on a GCP e2-micro VM. See loremaster.md's "Current State" section for the up-to-date
feature summary, and `docs/next-session.md` for open items.
