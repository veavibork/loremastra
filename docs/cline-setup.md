# Cline Setup & Tooling Reference

This document describes the Cline-specific tooling configured for this repo. It's the
single place to look when setting up Cline on a new machine or onboarding a collaborator.

> **Using OMP?** See [`docs/omp-setup.md`](omp-setup.md) and the root
> [`CLAUDE.md`](../CLAUDE.md) instead. This document is kept for Cline-only users.

---

## `.clinerules/` — project rules (loaded into every Cline session)

Each `.md` file in `.clinerules/` is injected into Cline's context at the start of every
conversation. Keep these focused — context budget matters.

| File               | What it covers                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `collaboration.md` | Discuss-before-act posture, checkpoint cadence, when to act autonomously                            |
| `stack.md`         | Full stack reference: languages, frameworks, commands, directory map, linting                       |
| `database.md`      | SQLite patterns: two-tier model, ad-hoc migrations, `ensureColumn`, `skipRecovery`, retired columns |
| `dev-workflow.md`  | Dev server lifecycle, MCP dev server tool list, environment variables, post-DB-edit protocol        |
| `frontend.md`      | React 19 + Vite 8 patterns, component naming, CSS conventions, oxlint rules                         |
| `testing.md`       | No test framework; script prefixes, key test scripts, when to add new scripts, DB-safety rules      |
| `worker-usage.md`  | When to use `ask_worker` vs. reading files in-context; how to call the cline-worker MCP tools       |

### Global rules

A global rule file at `C:\Users\hoborg\Documents\Cline\Rules\working-type.md` applies to
all working directories. It sets the senior-engineer mentor posture and ADHD-friendly
one-step-at-a-time workflow.

---

## `.mcp.json` — MCP servers

Three MCP servers are registered:

### `loremaster-dev` (project's own)

- **Source:** `src/mcp/dev-server.ts`
- **Starts:** automatically with Cline (via `.mcp.json`), or manually via `npm run mcp`
- **Purpose:** live state inspection during development — reads SQLite directly, not
  through HTTP
- **Tools:** `list_stories`, `get_worldbook`, `get_queue_status`, `get_recent_log`,
  `tail_dev_server_log`, `get_recent_outbound_requests`, `get_memory_summary`,
  `get_memory_manifest`, `get_prompt_preview`, `enqueue_memory_jobs`, `backfill_memory`,
  `notify_direct_mutation`

### `context7` (third-party)

- **Package:** `@upstash/context7-mcp`
- **Purpose:** up-to-date library documentation for fast-moving dependencies (Hono,
  React 19, better-sqlite3, MCP SDK). Cline can query current API docs instead of
  relying on training data.
- **Note:** runs via `npx -y`, so it downloads on first use. No API key required.

### `cline-worker` (project's own)

- **Source:** `src/mcp/cline-worker.ts`
- **Purpose:** gives Cline access to a cheap 1-slot Featherless model (default:
  `NousResearch/Hermes-3-Llama-3.1-8B`) for lightweight code lookup / Q&A tasks.
  Uses the existing `completeChat()` inference layer — no tool-calling needed.
- **Tools:** `ask_worker` (code Q&A with file/grep context), `list_worker_models`
  (discover 1-slot models on your plan)
- **Config:** `CLINE_WORKER_API_KEY` and `CLINE_WORKER_MODEL` in `.env`
- **See also:** `.clinerules/worker-usage.md` for when to use it vs. reading files
  in-context

---

## `.vscode/` — workspace config

### `settings.json`

Editor settings: format on save, 2-space tabs, UTF-8, trailing-whitespace trimming.
Search excludes for `node_modules/`, `dist/`, `data/`, `*.sqlite*`, log files.
TypeScript SDK pinned to the workspace's `node_modules/typescript/lib`.

### `tasks.json`

Common dev commands exposed as VS Code tasks (Ctrl+Shift+P -> "Run Task"):

| Task label         | Command                     |
| ------------------ | --------------------------- |
| `dev (backend)`    | `npm run dev`               |
| `dev (frontend)`   | `npm run dev` (in `web/`)   |
| `typecheck`        | `npm run typecheck`         |
| `build (backend)`  | `npm run build`             |
| `build (frontend)` | `npm run build` (in `web/`) |
| `lint (frontend)`  | `npm run lint` (in `web/`)  |
| `db:init`          | `npm run db:init`           |
| `server:restart`   | `npm run server:restart`    |
| `server:reset-db`  | `npm run server:reset-db`   |
| `server:fresh`     | `npm run server:fresh`      |
| `mcp`              | `npm run mcp`               |

### `extensions.json`

Recommended extensions surfaced to anyone opening the workspace:

| Extension                                | Purpose                                            |
| ---------------------------------------- | -------------------------------------------------- |
| `ms-vscode.typescript-language-features` | TypeScript language support                        |
| `oxc.oxc`                                | oxlint integration for frontend linting            |
| `qwtel.sqlite-viewer`                    | Inspect dev SQLite databases in `data/`            |
| `yzhang.markdown-all-in-one`             | Markdown editing / preview                         |
| `mikestead.dotenv`                       | `.env` file syntax                                 |
| `stevencl.addDoc-comments`               | JSDoc comment generation                           |
| `eamodio.gitlens`                        | Git history and blame (useful for vibe-coded repo) |
| `saoudrizwan.claude-dev`                 | Cline itself                                       |

Prettier is configured (`.prettierrc`, `.prettierignore`) with a `lint-staged` pre-commit hook auto-formatting staged files on commit. Run `npm run format` from root or `web/` to format all files.

---

## First-time setup checklist

1. **Install dependencies:**
   ```
   npm install
   cd web && npm install
   ```
2. **Copy `.env.example` to `.env`** and set:
   - `APP_MASTER_KEY` (32-byte hex)
   - `CLINE_WORKER_API_KEY` (Featherless API key for the cline-worker MCP server)
3. **Initialize the database:**
   ```
   npm run db:init
   ```
4. **Create a user:**
   ```
   npm run user:create -- <name> <password>
   ```
5. **Open VS Code** in the repo root. Accept the recommended extension prompts.
6. **Start the dev servers** using VS Code tasks or:
   ```
   npm run dev           # backend (terminal 1)
   cd web && npm run dev # frontend (terminal 2)
   ```
7. **Verify Cline MCP servers** are running: check the Cline panel for `loremaster-dev`,
   `context7`, and `cline-worker` in the MCP servers list.

---

## Other AI tooling in this repo (not Cline)

- **`CLAUDE.md` + `.claude/agents/`** — Claude Code sub-agent routing
  (`lookup`, `researcher`, `quick-edit`). These are Claude Code-specific and do not
  affect Cline. Kept for when Claude Code is used instead of Cline.
- **`loremaster.md`** — the authoritative project reference. Read by all AI assistants
  (Cline, Claude Code, Cursor). Not a Cline rule file, but serves as the primary context
  document for understanding the project's mission, architecture, and terminology.
