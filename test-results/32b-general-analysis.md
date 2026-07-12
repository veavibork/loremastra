## How listModels works

`listModels(apiKey, filters?)` calls `GET /v1/models` with URL params for search query, capability/tag filters, context-length range, plan gating, and pagination (`perPage`, `page`, default 100). Returns `FeatherlessModel[]`. When `requireToolUse` is set, the API receives `capabilities=chat,tool-use` server-side, then a client-side `.filter(m => m.toolUse)` catches the ~5% false positives.

## How the eval script uses it

`main()` calls `listModels` in a `while(true)` loop with `page++`, stopping when a page returns fewer items than `perPage`. Each model is filtered: must have `toolUse`, not be gated, have context ≥32K, and be 1 or 2 concurrency cost. Survivors are scored by `analyzeModel()` (family, params, creative/instruct heuristics) and ranked into 1-slot / 2-slot tables against a Hermes-3-8B baseline.

## One improvement

The page-count stop condition (`models.length < perPage`) breaks early if the last page is exactly full — the loop keeps going for one empty page. Better: track a `totalPages` or `total` from API response headers if available, or send `page=1` and `page=2` concurrently to halve latency for the common ~2-page result set.
