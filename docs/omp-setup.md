# OMP Setup & Tooling Reference

This document explains how to run this project through **Oh My Pi (OMP)**, the
AI coding harness we're switching to from Cline. It is the OMP-specific companion
to `CLAUDE.md`. For the Cline equivalent, see `docs/cline-setup.md`.

---

## How OMP reads context

OMP auto-reads `CLAUDE.md` at the start of every session. Everything in this repo's
`CLAUDE.md` is assumed to be true for the current session. The `.clinerules/`
directory is **not** read by OMP; it is only for Cline.

So for OMP-driven work:

- Keep universal conventions (stack, DB patterns, workflow) in `CLAUDE.md`.
- Keep longer topic guides (this file, Cline setup) in `docs/`.
- Keep Cline rules in `.clinerules/` unchanged for anyone still using Cline.

---

## What changed from Cline

| Area              | Cline setup                                                 | OMP setup                                             |
| ----------------- | ----------------------------------------------------------- | ----------------------------------------------------- |
| Context files     | `.clinerules/*.md` auto-injected                            | `CLAUDE.md` auto-read; `docs/omp-setup.md` referenced |
| VS Code extension | `saoudrizwan.claude-dev` (Cline)                            | OMP extension / server (whatever you installed)       |
| Plan/act mode     | Built-in Cline UI                                           | "Discuss before acting" convention in `CLAUDE.md`     |
| Tools             | Cline-specific tools (`read_file`, `execute_command`, etc.) | OMP tools (`read`, `bash`, `edit`, `task`, etc.)      |
| MCP servers       | Read from `.mcp.json` by Cline                              | Read from `.mcp.json` by OMP MCP integration          |
| Sub-agents        | Cline-only modes                                            | OMP `task`, `agent`, `completion` helpers             |

---

## MCP servers

`.mcp.json` is shared between Cline and OMP — MCP is a protocol, not tied to a
client. All three servers work the same way in OMP.

```json
{
  "mcpServers": {
    "loremaster-dev": {
      "command": "npx",
      "args": ["tsx", "src/mcp/dev-server.ts"]
    },
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    },
    "cline-worker": {
      "command": "npx",
      "args": ["tsx", "src/mcp/cline-worker.ts"]
    }
  }
}

**Windows:** `.omp/mcp.json` takes priority over `.mcp.json` for OMP sessions (per OMP docs).
It wraps each server command with `cmd /c` for Windows compatibility and adds explicit `type: "stdio"`
and `cwd` fields. If both files exist, `.omp/mcp.json` wins for OMP.
```

The `cline-worker` name is a legacy label — it still works for OMP; the server is
generic. It gives the coding assistant access to a cheap 1-slot Featherless model
for lookup tasks. Config in `.env`:

```env
CLINE_WORKER_API_KEY=sk-featherless-...
CLINE_WORKER_MODEL=NousResearch/Hermes-3-Llama-3.1-8B
```

### What each MCP server does

| Server           | Tools                                                                                                                                                                                                                                                               | Use when                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `loremaster-dev` | `list_stories`, `get_worldbook`, `get_queue_status`, `get_recent_log`, `tail_dev_server_log`, `get_recent_outbound_requests`, `get_memory_summary`, `get_memory_manifest`, `get_prompt_preview`, `enqueue_memory_jobs`, `backfill_memory`, `notify_direct_mutation` | You need live app state (queue, logs, memory, prompt assembly)                              |
| `context7`       | Library-specific lookups                                                                                                                                                                                                                                            | You need current API docs for Hono, React 19, better-sqlite3, MCP SDK                       |
| `cline-worker`   | `ask_worker`, `list_worker_models`                                                                                                                                                                                                                                  | You have a narrow code lookup question and don't want to burn workhorse model context/slots |

---

## Model setup on Featherless

Featherless gives you 8 concurrency slots. Large workhorse models (GLM-5.2,
Kimi-K2.7-Code, DeepSeek V4 Pro) cost **4 slots each**, so only one fits at a time
if anything else is running.

### Recommended main model for OMP coding work: Kimi-K2.7-Code

Tested clean and finishes reliably. Use it as the model for your OMP session when
writing, editing, and debugging code.

### Keep DeepSeek V4 Pro as the in-app prose workhorse

DeepSeek V4 Pro is the high-quality Author/narration model. Through OMP it can handle
short tool calls, but long code-generation tool calls may hang in reasoning drafts.
Continue to select it in the app's **Config > Agents** tab for story generation; just
do not use it as the main OMP model.

### Model behavior matrix

| Model                                | Slots | Tool calls through OMP                                      | Notes                                                                                                                                                                                                       |
| ------------------------------------ | ----- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zai-org/GLM-5.2`                    | 4     | **Intermittent corruption**                                 | Raw API is clean. OMP sees leaked XML / empty args. Session degrades once corruption starts. Avoid for now.                                                                                                 |
| `moonshotai/Kimi-K2.7-Code`          | 4     | **Clean** (empirically tested)                              | Single and multi-tool calls pass; finishes in ~65s with moderate reasoning. **Recommended main model for OMP coding work**.                                                                                 |
| `deepseek-ai/DeepSeek-V4-Pro`        | 4     | **Clean short calls; slow long calls** (empirically tested) | Multi-tool call passes, but long tool calls can enter long reasoning drafts and exceed 280s timeout. Best used as the app's **prose/narration workhorse** (Author agent), not as the main OMP coding model. |
| `NousResearch/Hermes-3-Llama-3.1-8B` | 1     | **Clean**                                                   | Default 1-slot model for `cline-worker`; good for cheap lookups.                                                                                                                                            |

### If you add more models

Use the raw API verification kit in `src/inference/schema/` to empirically test a new
model before relying on it. The gist contains:

- `req-toolcall.json` — long single tool-call to detect mid-stream arg corruption
- `req-multitool.json` — two tool calls in one turn to detect duplicate tool-call IDs
- `parse.py` — reconstruct tool-call args and report validity / duplicate IDs / reasoning field

Example:

```bash
cd src/inference/schema
# Replace MODEL_ID_HERE in req-toolcall.json first
KEY=$CLINE_WORKER_API_KEY API=https://api.featherless.ai/v1/chat/completions \
  bash -c 'curl -sN --max-time 280 "$API" \
    -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" \
    -d @req-toolcall.json > stream1.txt'
python3 parse.py stream1.txt
```

Only switch a model to main use after both `req-toolcall.json` and `req-multitool.json`
pass twice cleanly.

---

## VS Code workspace

The existing `.vscode/` configuration is client-agnostic and works for OMP too:

| File                      | Purpose                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `.vscode/settings.json`   | Editor defaults (2-space tabs, no default formatter, TypeScript SDK, search excludes)                                    |
| `.vscode/tasks.json`      | Common dev commands as VS Code tasks (`dev (backend)`, `dev (frontend)`, `typecheck`, `db:init`, `server:restart`, etc.) |
| `.vscode/extensions.json` | Recommended extensions (TypeScript, oxc, SQLite viewer, markdown, dotenv, GitLens)                                       |

You do **not** need an OMP-specific VS Code extension in `extensions.json`. OMP is
configured in the OMP server/interface separately.

---

## What to keep from Cline setup

| Cline artifact            | Keep?                                | Why                                                                |
| ------------------------- | ------------------------------------ | ------------------------------------------------------------------ |
| `.clinerules/*.md`        | Yes                                  | Still needed for anyone using Cline. OMP ignores them.             |
| `.mcp.json`               | Yes                                  | Standard MCP; shared.                                              |
| `src/mcp/cline-worker.ts` | Yes for now; consider renaming later | The code is generic, but the name is Cline-branded. Safe to leave. |
| `docs/cline-setup.md`     | Yes                                  | Cline onboarding reference.                                        |
| `.vscode/settings.json`   | Yes                                  | Client-agnostic.                                                   |
| `.vscode/tasks.json`      | Yes                                  | Runs the same npm scripts OMP will use.                            |
| `.vscode/extensions.json` | Yes                                  | Remove or keep `saoudrizwan.claude-dev` if no one uses Cline.      |

---

## First-time OMP setup steps

1. **Close any Cline session** to free up the 8 Featherless concurrency slots.
2. **Start a fresh OMP session** in `C:/Users/hoborg/Desktop/lorepalace`.
3. **Verify OMP auto-reads `CLAUDE.md`** by checking the session context/prompt — it should
   mention the Loremaster working guide.
4. **Verify MCP servers launch** from `.mcp.json`:
   - `loremaster-dev`
   - `context7`
   - `cline-worker`
5. **Run a quick tool-call smoke test** in OMP:
   - Ask for a `read` of the project root.
   - If it returns empty args (`{}`), the main model has the GLM-5.2 XML-leak bug — switch to Kimi-K2.7-Code or DeepSeek V4 Pro before doing real work.
6. **Run backend + frontend dev servers** with the usual commands:
   ```bash
   npm run dev          # repo root
   cd web && npm run dev
   ```
7. **Run a backend smoke test**:
   ```bash
   npx tsx scripts/test-memory-pipeline-smoke.ts
   ```

---

## OMP tool quick reference

These are the tools you'll use most often. Full docs are in OMP itself.

| Tool                    | Uses                                                    |
| ----------------------- | ------------------------------------------------------- |
| `read`                  | Read files, directories, archives, URLs, SQLite         |
| `write`                 | Create or overwrite files                               |
| `edit`                  | Surgical text replacements with fuzzy matching          |
| `bash`                  | Shell commands (single binary calls or short pipelines) |
| `grep`                  | Regex search with Rust regex                            |
| `glob`                  | Find files by pattern                                   |
| `ast_grep` / `ast_edit` | Syntax-aware search and rewrites                        |
| `lsp`                   | Definition, references, rename, diagnostics             |
| `task`                  | Delegate work to sub-agents                             |

**Important:** avoid parallel tool-call batches on 4-slot models. GLM-5.2 corrupted them;
Kimi-K2.7-Code has been clean on single calls but batching still multiplies the chance
of XML mishaps. If you need parallel work, use `task` sub-agents, which communicate
through files rather than multi-tool responses.

---

## Troubleshooting

### Every tool call returns empty arguments `{}`

The main model is leaking XML tags into tool-call arguments. Switch to
`moonshotai/Kimi-K2.7-Code` or `deepseek-ai/DeepSeek-V4-Pro`.

### MCP servers don't start

- Check that dependencies are installed: `npm install`
- Check that `.env` has `CLINE_WORKER_API_KEY` if using `cline-worker`
- Try starting one manually: `npm run mcp`
- Check the OMP MCP/integration panel for stderr

### Responses degrade / Chinese text leaks into English replies

This is the GLM-5.2 degradation pattern. Start a fresh session with a different model;
do not try to continue the corrupted session.

### 429 errors when testing models

You're hitting Featherless concurrency. On the 4-slot workhorse models, run tests
sequentially with 45-second backoff as noted in `src/inference/schema/README.md`.

---

## Future cleanup candidates

Once everyone is fully on OMP and no one uses Cline, consider:

1. Renaming `cline-worker` MCP server and `src/mcp/cline-worker.ts` to something
   model-neutral like `lookup-worker` or `inference-worker`.
2. Renaming `CLINE_WORKER_API_KEY` / `CLINE_WORKER_MODEL` to `LOOKUP_WORKER_API_KEY` /
   `LOOKUP_WORKER_MODEL`.
3. Removing `saoudrizwan.claude-dev` from `.vscode/extensions.json` recommendations.
4. Merging any `.clinerules/` conventions worth carrying into `CLAUDE.md`.

None of these are required for OMP to work. Leave them until they actually cause
confusion.
