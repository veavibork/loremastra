# 32B Coder Subagent Analysis

## How listModels works

`listModels(apiKey, filters)` queries `api.featherless.ai/v1/models` with URL params from `ListModelsFilters`: `q`, tags per category, `contextLengthMin`/`Max`, `availableOnCurrentPlan`, pagination via `perPage` (default 100) + `page`. Tags merge `capabilities=chat,tool-use` when `requireToolUse` is set. Returns `FeatherlessModel[]`. `requireToolUse=true` filters client-side post-fetch as server capability param is imprecise (~5% false positives). No total-count — caller detects end by an empty page.

## How the eval script uses it
The script calls `suggestFiltersForRole("worker")` for base filters, sets `perPage=200`, then loops pages calling `listModels` until an empty page. Per-model: drops gated, <32K context, non-1/2 concurrency, non-tool-use. `analyzeModel` pattern-scores each candidate, then ranked by score split into 1-slot/2-slot tables with Hermes-3-8B baseline.

## One improvement

The cutoff check `models.length < perPage` assumes the last page returns fewer items. A page landing exactly `perPage` with no further data causes an infinite loop. Safer: cap iterations at `maxPages` or use cursor-based pagination.
