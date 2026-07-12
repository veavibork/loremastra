# Loremaster

A lightweight, private roleplaying platform for a small group of trusted users, built for long-form RP stories. See [loremaster.md](loremaster.md) for the full project reference (mission, architecture, terminology, and roadmap context).

**Memory model (2026-07-04):** rolling `[STORY TO DATE]` Editor recaps + verbose recent posts. Per-post compression is dormant; decad archive blocks remain active. See [docs/story-to-date-experiment.md](docs/story-to-date-experiment.md).

**Author streaming UX (2026-07-04):** prefill countdown, live reasoning trace (`delta.reasoning` on
Featherless V4-Pro), server-anchored elapsed timers — see [docs/featherless-notes.md](docs/featherless-notes.md)
and [docs/reasoning-stream-research.md](docs/reasoning-stream-research.md) (thinking/Effort probe matrix, 2026-07-04).
(raw probe: `scripts/probe-deepseek-raw.ts`).

## Stack

- **Backend:** Node/TypeScript, [Hono](https://hono.dev/), better-sqlite3
- **Frontend:** React + Vite (in `web/`)
- **Inference providers:** Featherless, [AI Horde](https://aihorde.net/)

## Setup

1. Install dependencies:
   ```
   npm install
   cd web && npm install
   ```
2. Copy `.env.example` to `.env` and fill in `APP_MASTER_KEY` (32-byte hex — encrypts per-user API keys at rest). Provider keys are set per user in the Agents tab, not in `.env`.
3. Initialize the database:
   ```
   npm run db:init
   ```
4. Create an admin-provisioned user account (no self-serve signup):
   ```
   npm run user:create -- <name> <password>
   ```

## Running

Backend:

```
npm run dev
```

Frontend (from `web/`):

```
npm run dev
```

Other useful scripts:

| Command                                         | Description                                                                                                                            |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                             | Type-check the backend without emitting                                                                                                |
| `npm run build`                                 | Compile the backend                                                                                                                    |
| `npm run mcp`                                   | Dev-tools MCP server (queue, logs, worldbook, memory manifest, prompt preview)                                                         |
| `npm run server:restart`                        | Restart the dev backend process                                                                                                        |
| `npm run server:reset-db`                       | Reset the local database                                                                                                               |
| `npm run server:fresh`                          | Reset the database and restart the backend                                                                                             |
| `npx tsx scripts/test-memory-pipeline-smoke.ts` | Memory pipeline smoke tests (in-process, no browser)                                                                                   |
| `npx tsx scripts/story-to-date-experiment.ts`   | Iterate on `[STORY TO DATE]` prompts against synced VM data — see [docs/story-to-date-experiment.md](docs/story-to-date-experiment.md) |

## Memory diagnostics (dev)

While a story is open, quick health checks:

```
GET  /api/stories/:id/memory/summary
GET  /api/stories/:id/memory/tag-activation
GET  /api/stories/:id/prompt-preview
GET  /api/stories/:id/story-to-date
POST /api/stories/:id/memory/backfill
```

See [loremaster.md](loremaster.md) (MCP Server section) for the full MCP tool list. Production deploy: [docs/gcp-deployment.md](docs/gcp-deployment.md).

## Project layout

- `src/` — backend (routes, services, db, queue)
- `web/` — frontend
- `scripts/` — one-off/dev scripts (DB init, user creation, dev server management)
- `docs/roadmap.md` — high-level backlog (open items only)
- `docs/development.md` — detailed milestone history and implementation notes
- `docs/reasoning-stream-research.md` — thinking/reasoning stream probes, Effort matrix, future per-model confirmation workflow
- `loremaster.md` — project mission, architecture, and terminology reference
