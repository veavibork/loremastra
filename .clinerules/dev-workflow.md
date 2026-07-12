# Development Workflow

## Dev server lifecycle

The backend and frontend are separate npm packages with separate dev servers:

- **Backend:** `npm run dev` (from repo root) — `tsx watch src/index.ts`, listens on
  `http://localhost:4113` (override with `PORT` env var).
- **Frontend:** `npm run dev` (from `web/`) — Vite dev server, proxies `/api` to the
  backend at `http://localhost:4113`.

Both must be running simultaneously for development. The Vite proxy means the frontend
talks to the backend through the same origin — no CORS configuration needed in dev.

### Restart vs. reset

| Command                   | What it does                                          |
| ------------------------- | ----------------------------------------------------- |
| `npm run server:restart`  | Kill and restart the dev backend process (keeps data) |
| `npm run server:reset-db` | Wipe the local SQLite databases (does not restart)    |
| `npm run server:fresh`    | Reset DB + restart backend in one step                |

`dev-server.log` in the repo root captures backend stdout/stderr (written by
`scripts/dev-restart.mjs`). The MCP tool `tail_dev_server_log` can read it without
leaving the Cline session.

## MCP dev server

The project exposes its own MCP server (`src/mcp/dev-server.ts`) for live state
inspection during development. It's registered in `.mcp.json` and auto-starts with
Cline. Run manually with `npm run mcp`.

Available MCP tools (all read-only except where noted):

| Tool                           | Purpose                                                 |
| ------------------------------ | ------------------------------------------------------- |
| `list_stories`                 | All stories with id, name, phase                        |
| `get_worldbook`                | Worldbook entries for a story (including hidden)        |
| `get_queue_status`             | Live queue + concurrency slots for a story              |
| `get_recent_log`               | Recent log entries (posts) for a story                  |
| `tail_dev_server_log`          | Tail `dev-server.log`                                   |
| `get_recent_outbound_requests` | Rolling log of outbound provider requests               |
| `get_memory_summary`           | Compact memory health check                             |
| `get_memory_manifest`          | Per-post memory diagnostics                             |
| `get_prompt_preview`           | Assembled Author prompt at current position (read-only) |
| `enqueue_memory_jobs`          | Queue eligible compress/archive jobs                    |
| `backfill_memory`              | Repair memory pipeline after direct DB edits            |
| `notify_direct_mutation`       | Invalidate browser session after out-of-band DB writes  |

### When to use what

- **MCP tools** — when Cline needs live application state (queue, logs, memory health,
  prompt assembly). These read SQLite directly, not through HTTP.
- **HTTP routes** — when testing API behavior or when `DEV_BYPASS_SESSION_GUARD` is set
  for curl-based automation. See `loremaster.md` for the full route list.
- **Standalone scripts** — `npx tsx scripts/<name>.ts` for one-off diagnostics and
  experiments. These open their own DB connections; use `skipRecovery: true` if calling
  `getStoryDb()` to avoid resetting in-flight jobs.

## Environment

- `.env` (gitignored) — `APP_MASTER_KEY` (32-byte hex, encrypts per-user API keys at rest).
  Provider API keys are set per-user in the app's Agents tab, not in `.env`.
- `LOREMASTER_DATA_DIR` — overrides the `data/` directory (used for VM-sync experiments).
  When working with synced VM data, set this to avoid touching your local dev database.
- `DEV_BYPASS_SESSION_GUARD` — when set on the server, HTTP routes skip session
  authentication. Useful for curl-based testing; never set in production.

## After direct DB edits

If you write to the database outside the HTTP API (ad-hoc script, manual SQL, MCP
`backfill_memory`), call `notify_direct_mutation` via the MCP server afterward. This
invalidates the current claimed session so any open browser tab 409s and reloads through
the normal claim/reclaim flow, instead of silently showing stale state.
