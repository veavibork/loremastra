# Disambiguation Catalog

Generated 2026-07-13. Purpose: catalog every naming collision, overload, drift, and orphan in the codebase before deciding what terms SHOULD be. The next step is discussing resolutions; this file only catalogs the problems.

---

## 1. Overloaded Terms — same name, multiple distinct meanings

### 1.1 "compression" (F-020c, F-024)

| #   | Meaning                                                | Where                                                                                          | Status                                                                  |
| --- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| a   | Per-post `gen_extract` Worker summaries                | `compression.ts`, `compress-worker.ts`, `memory-config.ts`, `content-stamp.ts`                 | **Retired** 2026-07-04; code dormant behind `COMPRESSION_ENABLED=false` |
| b   | Story-to-date rolling recap (Editor)                   | `story-to-date.ts`, `story-to-date-worker.ts`, `pipeline-runner.ts` (job type `story-to-date`) | **Active**                                                              |
| c   | Story-to-date FOLD — merge oldest segments into digest | `story-to-date-fold-worker.ts`, `story-to-date-corpus.ts` (fold functions)                     | **Active**                                                              |

Also: `compression.ts` vs `compress-worker.ts` — inconsistent noun/verb prefix (F-024).

### 1.2 "memory"

| #   | Meaning                                                       | Where                                                                                                     |
| --- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| a   | Story-to-date memory pipeline (Editor recaps)                 | `memory-manifest.ts`, `memory-invalidation.ts`, `memory-config.ts`, `/api/stories/:id/memory/*` endpoints |
| b   | Memory tab — prompt assembly inspector                        | `MemoryView.tsx`, `prompt-preview.ts`                                                                     |
| c   | `memory_content_stamp` column — content integrity fingerprint | `page-store.ts`, `content-stamp.ts`                                                                       |

`memory-config.ts` is actually one boolean: `COMPRESSION_ENABLED = false`. Not a config.

### 1.3 "book"

| #   | Meaning                                                       | Where                                                     |
| --- | ------------------------------------------------------------- | --------------------------------------------------------- |
| a   | 'game' book — story container (parent of logbook + worldbook) | `book-store.ts`, `stories.ts:128`                         |
| b   | 'logbook' book — the post/chat log chain                      | `book-store.ts`, `post-index.ts`, `story-to-date.ts`      |
| c   | 'worldbook' book — lore entries (CONTENT/ROSTER/MEMORY)       | `book-store.ts`, `worldbook-store.ts`                     |
| d   | 'sourcebook' — unused/deferred                                | `book-store.ts` (in `BookType` union, zero runtime usage) |
| e   | 'user' book — user metadata container                         | `book-store.ts`                                           |

All five live in one `book` table discriminated by `book_type`. "book" means everything and nothing.

### 1.4 "settings"

| #   | Meaning                                                         | Where                                                          |
| --- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| a   | Settings UI section (preferences: theme, font, spacing)         | `SettingsView.tsx`, `AccountSettings.tsx`                      |
| b   | Settings spaces — JSON blobs for configurable feature spaces    | `settings-space-store.ts`, `settings-space-registry.ts`        |
| c   | Model/agent config — provider, model, parameters per agent role | `model-config-store.ts`, `agent-config.ts`, `AgentsView.tsx`   |
| d   | Input bar toggles — length/mood/param/effort/model presets      | `toggle-presets.ts`, `storyToggles.tsx`, `playTabSettings.tsx` |

### 1.5 "log"

| #   | Meaning                                                           | Where                                                                       |
| --- | ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| a   | System logs — append-only JSON lines                              | `outbound-log.ts` (inference calls), `pipeline-health.ts` (queue snapshots) |
| b   | Story log — chat/post history                                     | `LogsView.tsx`, `log-view.ts`, `LogEntry` interface                         |
| c   | Logbook — the database entity holding all pages/texts for a story | `book-store.ts` (bookType `'logbook'`), `post-index.ts`                     |

### 1.6 "archive" (F-020 — partially resolved)

| #   | Meaning                                                                                          | Where                                                      |
| --- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| a   | Decad archive blocks — scene summaries (10-post windows)                                         | `archive.ts`, `archive-eligibility.ts`, `archive-store.ts` |
| b   | Archives tab — manages story-to-date segments + optional scene titles                            | `ArchivesView.tsx`, `archive-view.ts`                      |
| c   | `archive-name` Worker jobs — generate scene titles for story-to-date segments (tab display only) | `pipeline-runner.ts`, `archive.ts`                         |
| d   | `archive-worker.ts` — dead code, zero imports (F-018)                                            | `src/services/archive-worker.ts`                           |

### 1.7 "worker"

| #   | Meaning                                                    | Where                                                                                                |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| a   | Worker agent — lightweight naming agent (role `'worker'`)  | `agent-config.ts`, `config.ts` (`DEFAULT_WORKER_PROFILE`)                                            |
| b   | Worker lane — queue lane for non-prose background jobs     | `worker-lanes.ts`                                                                                    |
| c   | Worker files — implementations of background job execution | `story-to-date-worker.ts`, `story-to-date-fold-worker.ts`, `compress-worker.ts`, `archive-worker.ts` |
| d   | Cline worker — MCP server for cheap code lookups           | `src/mcp/cline-worker.ts`                                                                            |

### 1.8 "story"

| #   | Meaning                                                                                                               | Where                                             |
| --- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| a   | Story entity — an RP session/save slot                                                                                | `story-store.ts`, `createStory()`                 |
| b   | Story phase — `'story'` (vs `'setup'`, `'kickoff'`)                                                                   | `story-state-store.ts` (`StoryPhase`)             |
| c   | Story navigation section — UI section containing Saves/Logs/Archives                                                  | `Nav.tsx`, `registry.tsx` (`'story:saves'` etc.)  |
| d   | `stories.ts` route file — handles stories + pages + texts + worldbook + memory + archives + kickoff + history + forks | `src/routes/stories.ts` (887 lines, 25+ handlers) |

### 1.9 "config"

| #   | Meaning                                                     | Where                                                                  |
| --- | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| a   | App-wide AgentProfile defaults                              | `src/config.ts`                                                        |
| b   | Agent config resolution — merges DB overrides with defaults | `src/services/agent-config.ts`                                         |
| c   | Agent config overrides — legacy one-row-per-role table      | `src/db/agent-config-store.ts`                                         |
| d   | Model config — current flat reorderable model list per user | `src/db/model-config-store.ts`                                         |
| e   | Provider-specific config — base URLs, user agents, timeouts | `src/inference/featherless-config.ts`, `src/inference/horde-config.ts` |
| f   | Feature flag — one boolean                                  | `src/services/memory-config.ts`                                        |

---

## 2. Synonym Drift — same concept, multiple names

### 2.1 Play tab / toggles / story toggles / presets

Same system (input bar quick-access generation controls) has four names:

| Name              | Where                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `play-tab`        | Settings space name (`PLAY_TAB_SPACE`), `play-tab.ts`, `playTabSettings.tsx`             |
| `toggle-presets`  | Backend service (`toggle-presets.ts`), settings space names (`TOGGLE_LENGTH_SPACE` etc.) |
| `storyToggles`    | Frontend component (`storyToggles.tsx`)                                                  |
| `PlayTabSettings` | Frontend interface (`playTabSettings.tsx`)                                               |

`play-tab.ts` (backend) exports `PLAY_TAB_SPACE` and `DEFAULT_PLAY_TAB_SETTINGS` — display settings (font, labels, bubbles).
`toggle-presets.ts` (backend) exports length/mood/param/effort presets.
`storyToggles.tsx` (frontend) imports from BOTH of the above and combines them.

### 2.2 Post / page / text / message / turn / entry

A single "thing in the conversation" has at least 7 representations:

| Name                   | Layer                                      | Where                        |
| ---------------------- | ------------------------------------------ | ---------------------------- |
| `pages` table row      | DB — one row per event                     | `page-store.ts`              |
| `texts` table row      | DB — the actual content, may have versions | `text-store.ts`              |
| `ChainPostEntry`       | Service — 1-based numbered post            | `post-index.ts`              |
| `LogEntry`             | Service — log display entry                | `log-view.ts`                |
| `PromptMessage`        | Frontend API type                          | `web/src/api.ts`             |
| `PromptPreviewMessage` | Backend service type                       | `prompt-preview.ts`          |
| `ChatMessage`          | Inference transport type                   | `featherless.ts`, `horde.ts` |
| "post"                 | User-facing term                           | docs, UI labels              |

### 2.3 Story-to-date naming variants

| Variant                                              | Where                              |
| ---------------------------------------------------- | ---------------------------------- |
| `story_to_date_segment`                              | DB table name (snake_case)         |
| `story-to-date`                                      | File/directory prefix (kebab-case) |
| `STORY TO DATE` / `STORY BEGINS` / `STORY CONTINUES` | Prompt tokens (UPPERCASE)          |
| `StoryToDateViewEntry`                               | Type name (PascalCase)             |

### 2.4 Story / save / session / slot

| Term        | Meaning                                                    |
| ----------- | ---------------------------------------------------------- |
| "story"     | RP session/save slot (DB, UI)                              |
| "Saves" tab | Manages stories/saves (`SavesView.tsx`)                    |
| "session"   | HTTP auth session (`session-store.ts`, `session-guard.ts`) |
| "slot"      | Inference concurrency slot (`slots.ts`)                    |

### 2.5 Space / tab / section

| Term      | Meaning                     | Where                                                   |
| --------- | --------------------------- | ------------------------------------------------------- |
| "space"   | JSON configuration blob     | `settings-space-store.ts`, `settings-space-registry.ts` |
| "tab"     | UI tab for a settings space | `play-tab.ts` (`PLAY_TAB_SPACE`)                        |
| "section" | Top-level navigation area   | `loremaster.md` UI Structure                            |

---

## 3. Legacy/Retired Terms Still Present

### 3.1 `gen_extract` (F-020b)

Retired per-post compression column. Still present in:

- `text-store.ts` — column schema, `fillTextExtract()`, `clearTextExtract()`
- `page-store.ts` — `memoryContentStamp` column
- `log-view.ts` — `LogEntry.genExtract`, `LogEntry.compressMetrics`
- `memory-manifest.ts` — references in manifest building
- `content-stamp.ts` — `postNeedsCompress()` references it

### 3.2 Dead worker files

| File                                          | Status                                             |
| --------------------------------------------- | -------------------------------------------------- |
| `src/services/compress-worker.ts` (238 lines) | Dormant — `COMPRESSION_ENABLED=false`              |
| `src/services/compression.ts` (65 lines)      | Dormant — enqueue logic guarded by flag            |
| `src/services/archive-worker.ts`              | Dead — zero imports across entire codebase (F-018) |

### 3.3 `compress` job type

Job type `'compress'` still referenced in:

- `compression.ts` — `enqueueEligibleCompressJobs()`
- `pipeline-runner.ts` — dispatch paths
- `job-store.ts` — `hasActiveJobForText()`
- `memory-config.ts` — the flag that disables it

---

## 4. Duplicated Type Definitions

### 4.1 `AgentRole` — defined in THREE files

| File                                          | Definition                                                 |
| --------------------------------------------- | ---------------------------------------------------------- |
| `src/db/agent-config-store.ts:5`              | `export type AgentRole = 'author' \| 'worker' \| 'editor'` |
| `src/db/model-config-store.ts:5`              | `export type AgentRole = 'author' \| 'worker' \| 'editor'` |
| `src/inference/featherless-tag-ratings.ts:17` | `export type AgentRole = 'worker' \| 'editor' \| 'author'` |

Same type, different source-of-truth. `agent-config.ts` re-exports from `model-config-store.ts`.

### 4.2 `layout.ts` filename collision

| File                     | Purpose                                        |
| ------------------------ | ---------------------------------------------- |
| `src/services/layout.ts` | Type definitions + defaults + validation logic |
| `src/routes/layout.ts`   | HTTP route handlers for layout CRUD            |

Same filename, different directories, different concerns. Ambiguous in grep results and stack traces.

---

## 5. File Naming Violations

### 5.1 Frontend PascalCase (F-023)

Four `.tsx` component files use camelCase:

| Current                        | Should be              |
| ------------------------------ | ---------------------- |
| `web/src/playTabSettings.tsx`  | `PlayTabSettings.tsx`  |
| `web/src/reasoningDisplay.tsx` | `ReasoningDisplay.tsx` |
| `web/src/registry.tsx`         | `Registry.tsx`         |
| `web/src/storyToggles.tsx`     | `StoryToggles.tsx`     |

### 5.2 Non-component camelCase

| File                           | Issue                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `web/src/globalCssSettings.ts` | Utility file in camelCase; convention is kebab-case (`global-css-settings.ts`) |

---

## 6. Semantic Ambiguity — name doesn't convey purpose (F-027)

### 6.1 `content-stamp.ts`

"Stamp" is abstract. It's a **SHA-256 content fingerprint** for integrity comparison. Also handles the legacy `postNeedsCompress()` check.

### 6.2 `memory-config.ts`

One boolean export (`COMPRESSION_ENABLED = false`). Not a configuration module — a single feature flag.

### 6.3 `play-tab.ts`

"Play tab" sounds like a UI tab element. It's actually the **story display area settings**: font size, role labels, speech bubbles, text colors.

### 6.4 `toggle-presets.ts`

"Toggle" (UI control) vs "preset" (data). Contains length steps, mood fragments, param overrides, and effort toggles. The frontend counterpart is `storyToggles.tsx`.

### 6.5 `worldbook-pc.ts`

"PC" = player character. But the file also:

- Resolves register/tone from CONTENT entries
- Builds CONTENT blocks for Worker prompts
- Provides PC name disambiguation for Worker summaries
- Balances speech quotes

Only ~60% of its exports are PC-related.

### 6.6 `kickoff.ts`

Name suggests kickoff-phase logic. Actually handles:

- `resolveIcStartPageId()` — find first visible IC page
- `isOpeningPostPage()` — check if a page is the opening post
- `finalizeSetup()` — hide all setup pages before opening

It's the **setup→story transition boundary**, not the kickoff phase itself.

---

## 7. Service / Store / Utility Boundary Blur

### 7.1 `story-to-date-admin.ts`

"Admin" in name but it's not an admin panel. Two functions: `removeStoryToDateSegment()` and `updateStoryToDateCoverageThroughPost()`. These are service operations, not admin-only.

### 7.2 `story-to-date-corpus.ts`

"Corpus" suggests data collection. Actually the **core algorithm module** for story-to-date: merge, count, coverage, batch selection, fold digestion, token estimation. The heaviest logic in the memory pipeline.

### 7.3 `global-css.ts` in services/

Purely a data constant (`DEFAULT_GLOBAL_CSS`) — no service logic. Should live in `config.ts`, `src/data/`, or with other defaults.

### 7.4 `db/time.ts`

A 3-line utility (`nowIso()`) in the db/ directory. No database dependency. Belongs in `src/lib/`.

---

## 8. Prefix / Grouping Inconsistency

### 8.1 Inference files

```
src/inference/
  featherless.ts           — main provider integration
  featherless-models.ts    — model discovery/filtering
  featherless-tag-ratings.ts — tag → role ratings
  featherless-config.ts    — base URL, user agent
  horde.ts                 — main provider integration (no horde-models.ts)
  horde-config.ts          — base URL, user agent
  reasoning-stream.ts      — generic, no provider prefix
  outbound-log.ts          — generic, logging
  hf-model-tags.ts         — HuggingFace model tags (sync script)
```

`horde-slots.ts` lives in `src/queue/` not `src/inference/` — split across directories.

### 8.2 Worker files vs their domain

| Worker                         | Domain Directory |
| ------------------------------ | ---------------- |
| `story-to-date-worker.ts`      | `services/`      |
| `story-to-date-fold-worker.ts` | `services/`      |
| `compress-worker.ts`           | `services/`      |
| `archive-worker.ts` (dead)     | `services/`      |

Worker implementations live in `services/`, but the queue infrastructure lives in `queue/`. The pipeline-runner references both. (F-011)

### 8.3 "Name" job types confusion

| Job type       | What it does                                                              |
| -------------- | ------------------------------------------------------------------------- |
| `story-name`   | Rename a story by asking Worker to read the first post                    |
| `archive-name` | Generate a scene title for a story-to-date segment (Archives tab display) |

"Name" in both but completely different purposes.

---

## 9. Frontend API Layer Naming

### 9.1 `api.ts` vs `api-coordinator.ts`

- `api.ts` (32KB) — all fetch functions, types, and response handling
- `api-coordinator.ts` (1.9KB) — concurrency limiter + GET dedup wrapper

"Coordinator" doesn't communicate "request throttling and deduplication."

---

## 10. Terminology Mismatch — code vs docs vs UI

| Code term                   | UI/docs term                    | Same thing?                                  |
| --------------------------- | ------------------------------- | -------------------------------------------- |
| `logbook` / `logbookId`     | "story"                         | Yes — the post chain for a story             |
| `page` (DB row)             | "post" / "message"              | Yes — a single event in the conversation     |
| `icPostNumber`              | "post number"                   | Yes — "IC" = in-character, never spelled out |
| `oocSessionStartPageId`     | (none)                          | "OOC" = out-of-character, never spelled out  |
| `PC` (in `worldbook-pc.ts`) | "player character"              | Yes — abbreviation in filename               |
| `genPackage` (code)         | "verbose text" / "prose" (docs) | Yes — the full post text                     |

---

## 11. Namespace Collisions

### 11.1 `data/` vs `src/data/` (F-008)

- `data/` (repo root) — runtime SQLite databases + logs
- `src/data/` — bundled JSON data (prompts reference data)

### 11.2 Duplicate `corrupted-tools/` (F-003)

- `corrupted-tools/omp-call-log.md` — repo root
- `src/inference/corrupted-tools/` — under inference source tree

### 11.3 `src/experiments/` vs `scripts/` (F-009, F-019)

- `src/experiments/story-to-date-corpus.ts` — 122-byte stub
- `scripts/story-to-date-experiment.ts` — the actual experiment

---

## Item Count

43 unique disambiguation items across 11 categories.
