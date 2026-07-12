## How listModels works

`listModels(apiKey, filters?)` sends a GET to Featherless's `/v1/models` endpoint with URL-encoded query params (`per_page`, `page`, `capabilities`, `context_length_min`, `max`, `q`, tags per category, `available_on_current_plan`). It maps the raw snake_case response through `mapModel()` to a camelCase `FeatherlessModel[]`. Server-side `capabilities=chat,tool-use` is approximate (~5% false positives), so the function re-filters `m.toolUse` client-side when `requireToolUse` is set. Pagination is manual: the caller increments `page` and stops when a page returns fewer items than `perPage`.

## How the eval script uses it

`main()` starts with `suggestFiltersForRole("worker")` (recommended tags, `availableOnCurrentPlan: true`), overrides `perPage: 200`, then loops pages. Each model is filtered post-fetch: must have `toolUse`, not be gated, have 32K+ context, and cost exactly 1 or 2 concurrency slots. Surviving models go through `analyzeModel()` which assigns a heuristic score (family bonus, instruct/creative/experimental penalties, parameter size and context/output length bonuses), then ranks and prints 1-slot and 2-slot tables plus comparisons against a Hermes-3-8B baseline.

## One improvement

The paging loop is O(N) pages of 200 — if the API ever returns 22K+ models this could take 110 sequential requests. Add a `maxPages` option or break early once the score ceiling plateaus (high-families dominate early pages; once scores drop below meaningful threshold, stop fetching).
