# OMP Setup & Tooling Reference

OMP-specific tooling: MCP servers, model recommendations, troubleshooting, and the raw API
test kit. For stack summary, commands, and workflow conventions, see `CLAUDE.md`. For coding
conventions, see `docs/conventions.md`.

---

## MCP Servers

Registered in `.mcp.json`:

| Server           | Source                    | Purpose                                                                                   |
| ---------------- | ------------------------- | ----------------------------------------------------------------------------------------- |
| `loremaster-dev` | `src/mcp/dev-server.ts`   | Live state inspection: stories, worldbook, queue, logs, memory, prompt preview            |
| `context7`       | `@upstash/context7-mcp`   | Up-to-date library docs (Hono, React 19, better-sqlite3, MCP SDK)                         |
| `cline-worker`   | `src/mcp/cline-worker.ts` | Cheap 1-slot Featherless model for code lookup / Q&A (`ask_worker`, `list_worker_models`) |

### MCP dev server tools

All read-only except where noted:

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

**When to use what:** MCP tools for live app state (read SQLite directly). HTTP routes for
testing API behavior or curl automation (`DEV_BYPASS_SESSION_GUARD` set). Standalone scripts
for one-off diagnostics (`npx tsx scripts/<name>.ts`).

### Worker model (`cline-worker`)

Cheap 1-slot Featherless model for lightweight code lookup, keeping the main model's context
and concurrency slots free. Config: `CLINE_WORKER_API_KEY` and `CLINE_WORKER_MODEL` in `.env`
(default: `NousResearch/Hermes-3-Llama-3.1-8B`).

**Use for:** "Where is X defined?", "What does this function do?", "Summarize this file", any
single-question lookup where the answer is short and factual.
**Don't use for:** Multi-file refactoring, design decisions, anything requiring your own model
to see the code (edits, writes), or tasks where you already have the file open.

---

## Model Recommendations

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

---

## Raw API Model Verification

Before relying on a new model in OMP, test it empirically. The kit lives in
`src/inference/schema/`:

- `req-toolcall.json` — long single tool-call to detect mid-stream arg corruption
- `req-multitool.json` — two tool calls in one turn to detect duplicate tool-call IDs
- `parse.py` — reconstruct tool-call args and report validity / duplicate IDs / reasoning field

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

## VS Code Workspace

The `.vscode/` configuration is client-agnostic:

| File                      | Purpose                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `.vscode/settings.json`   | Editor defaults (2-space tabs, no default formatter, TypeScript SDK, search excludes)                                    |
| `.vscode/tasks.json`      | Common dev commands as VS Code tasks (`dev (backend)`, `dev (frontend)`, `typecheck`, `db:init`, `server:restart`, etc.) |
| `.vscode/extensions.json` | Recommended extensions (TypeScript, oxc, SQLite viewer, markdown, dotenv, GitLens)                                       |

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

## Future Cleanup Candidates

1. Renaming `cline-worker` MCP server and `src/mcp/cline-worker.ts` to something
   model-neutral like `lookup-worker` or `inference-worker`.
2. Renaming `CLINE_WORKER_API_KEY` / `CLINE_WORKER_MODEL` to `LOOKUP_WORKER_API_KEY` /
   `LOOKUP_WORKER_MODEL`.
3. Removing `saoudrizwan.claude-dev` from `.vscode/extensions.json` recommendations.

None of these are required for OMP to work. Leave them until they actually cause
confusion.
