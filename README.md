# Loremaster

A lightweight, private roleplaying platform for a small group of trusted users, built for long-form RP stories. See [loremaster.md](loremaster.md) for the full project reference (mission, architecture, terminology, and roadmap context).

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
2. Copy `.env.example` to `.env` and fill in `FEATHERLESS_API_KEY`.
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

| Command | Description |
|---|---|
| `npm run typecheck` | Type-check the backend without emitting |
| `npm run build` | Compile the backend |
| `npm run mcp` | Start the dev-tools MCP server (queue status, logs, worldbook inspection) |
| `npm run server:restart` | Restart the dev backend process |
| `npm run server:reset-db` | Reset the local database |
| `npm run server:fresh` | Reset the database and restart the backend |

## Project layout

- `src/` — backend (routes, services, db, queue)
- `web/` — frontend
- `scripts/` — one-off/dev scripts (DB init, user creation, dev server management)
- `docs/roadmap.md` — active planning and milestone tracking
- `loremaster.md` — project mission, architecture, and terminology reference
