# Worker MCP Usage

The `cline-worker` MCP server (`src/mcp/cline-worker.ts`) exposes a cheap 1-slot
Featherless model for lightweight code lookup tasks, keeping the main model's context
and concurrency slots free for substantive work.

## When to use `ask_worker`

**Use it for:**

- "Where is X defined?" / "What does this function do?"
- "Summarize what this file does"
- "Find all uses of X and explain the call pattern"
- Any single-question lookup where the answer is short and factual

**Don't use it for:**

- Multi-file refactoring (you need the full context yourself)
- Design decisions requiring conversation history
- Anything requiring your own model to see the code (edits, writes)
- Tasks where you already have the file open in your context

## How to call it

```
ask_worker({
  question: "What does the ensureColumn function do?",
  files: ["src/db/story-db.ts"]
})
```

```
ask_worker({
  question: "Where is withModelFallback used?",
  searchPattern: "withModelFallback"
})
```

## `list_worker_models`

Call this to discover other 1-slot models available on your Featherless plan. Useful
when evaluating whether to switch `CLINE_WORKER_MODEL` to a different model.

## Configuration

- `CLINE_WORKER_API_KEY` — Featherless API key (in `.env`)
- `CLINE_WORKER_MODEL` — model id (default: `NousResearch/Hermes-3-Llama-3.1-8B`)

Both are read at MCP server startup. Restart the Cline session after changing them.
