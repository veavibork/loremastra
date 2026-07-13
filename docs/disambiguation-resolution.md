# Disambiguation Resolution

Generated 2026-07-13. Purpose: map every catalog item to its canonical replacement. This is the rename plan — no code changes yet.

---

## Format

Each item: **problem → canon → reasoning → confirmed?**

---

## 1. Overloaded Terms

### 1.1 "compression" → ✅ CONFIRMED

| #   | Concept                               | Decision                                                                                                                                          |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | Per-post gen_extract Worker summaries | **Purge.** Delete `compression.ts`, `compress-worker.ts`, `COMPRESSION_ENABLED`, `compress` job type, `gen_extract` column, `postNeedsCompress()` |
| b   | Story-to-date rolling recap           | **Keep "story-to-date."** Already consistent across files, job types, API                                                                         |
| c   | Story-to-date FOLD                    | **Keep "story-to-date fold."** Already consistent                                                                                                 |

**Reasoning:** No rename needed. Dead code (a) pollutes namespace; purge it and the remaining concepts stand clear.

**Cleanup targets:** `src/services/compression.ts`, `src/services/compress-worker.ts`, `src/services/archive-worker.ts`, `gen_extract` column + functions in `text-store.ts`, `memoryContentStamp` in `page-store.ts`, `compress` job type in `pipeline-runner.ts`, `COMPRESSION_ENABLED` in `memory-config.ts`.

### 1.2 "memory" → ✅ CONFIRMED

| #   | Concept                                  | Decision                                                                                                                                        |
| --- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | Story-to-date memory pipeline            | **→ "context."** `memory-manifest.ts` → `context-manifest.ts`, `memory-invalidation.ts` → `context-invalidation.ts`, API `/memory` → `/context` |
| b   | Memory tab (prompt inspector)            | **→ "Context" tab.** Shows assembled LLM context                                                                                                |
| c   | `memory_content_stamp` column            | **→ `content_hash`.** It's a SHA-256 fingerprint                                                                                                |
| d   | `memory-config.ts` (COMPRESSION_ENABLED) | **Deleted** in 1.1 purge                                                                                                                        |

**Reasoning:** "Context" is what gets injected into the prompt — the output of story-to-date. The column is a hash, call it a hash. The config file is the already-retired compression flag.

### 1.3 "book" → ✅ CONFIRMED

| #   | Concept                       | Decision                                                          |
| --- | ----------------------------- | ----------------------------------------------------------------- |
| a   | 'game' book — story container | **→ 'story'.** Matches UI/docs. Legacy "game" from AI Dungeon era |
| b   | 'logbook' — post chain        | **Keep.** Established RP term                                     |
| c   | 'worldbook' — lore entries    | **Keep.** Established RP term                                     |
| d   | 'sourcebook' — unused         | **Delete from BookType union.** Zero runtime usage                |
| e   | 'user' — metadata             | **Keep.** Clear purpose                                           |

**Reasoning:** One rename (`'game'` → `'story'`), one deletion (`'sourcebook'`). `book_type` column becomes `'story' | 'logbook' | 'worldbook' | 'user'`.

### 1.4 "settings" → ✅ CONFIRMED

| #   | Concept                                | Decision                                                                                            |
| --- | -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| a   | Settings UI tab (theme, font, spacing) | **→ "Preferences."** `SettingsView.tsx` → `PreferencesView.tsx`, route `/settings` → `/preferences` |
| b   | Settings spaces (JSON config blobs)    | **Keep.** Internal mechanism, not user-facing                                                       |
| c   | Model/agent config (Agents tab)        | **Keep.** Already branded "Agents"                                                                  |
| d   | Play tab display settings              | **Keep "play settings."** Subset of display preferences; collision is with toggle-presets (→ 2.1)   |

**Reasoning:** One rename clears the category. User-facing tab becomes "Preferences"; internal "settings spaces" mechanism is fine; "Agents" already distinct; play display addressed in 2.1.

### 1.5 "log" → ✅ CONFIRMED

| #   | Concept                                           | Decision                                                                                  |
| --- | ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| a   | System logs (outbound-log.ts, pipeline-health.ts) | **→ "telemetry."** `outbound-log.ts` → `outbound-telemetry.ts`. `pipeline-health.ts` keep |
| b   | Story log — chat history viewer                   | **Keep "log."** It IS a chronological record of posts                                     |
| c   | Logbook — DB book type                            | **Keep.** Already resolved in 1.3                                                         |

**Reasoning:** One rename. "Telemetry" = operational observability; "log" = user-facing chat history.

### 1.6 "archive" → ✅ CONFIRMED (REVISED)

| #   | Concept                                                                                                                                                                          | Decision                                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | Legacy `archive` table + `archive_member` + `archive-store.ts` + `archive.ts` + `archive-eligibility.ts` + `archive-view.ts` + `archive-worker.ts` (dead) + `'archive'` job type | **Delete all.** Already purged on every open via `purgeLegacyArchives`. 5 files, 1 job type, 2 DB tables                                                                      |
| b   | Archives tab — currently shows legacy archive view                                                                                                                               | **→ "Segments" tab.** Point at `story-to-date-view.ts` (already exists). `ArchivesView.tsx` → `SegmentsView.tsx`, layout label `'story:archives'` → `'story:segments'`        |
| c   | `archive-name` job type — crossover used by BOTH legacy archive and active segments                                                                                              | **→ `segment-name`.** Rename in job_type enum, `story-to-date.ts`, `story-to-date-view.ts`, `story-to-date-store.ts`, `pipeline-runner.ts`. Remove from `purgeLegacyArchives` |

**Reasoning:** Legacy decad archive system is fully retired (purged on open). `archive-name` is the lone crossover — rename it to belong exclusively to segments. Delete the rest. Two distinct systems collapsed into "archive" → one gone, one properly named.

### 1.7 "worker" → ✅ CONFIRMED

| #   | Concept                                            | Decision                                             |
| --- | -------------------------------------------------- | ---------------------------------------------------- |
| a   | Worker agent — lightweight naming agent            | **Keep "Worker."** Clear agent role name             |
| b   | Worker lane — queue lane for non-prose jobs        | **→ "job lane."** `worker-lanes.ts` → `job-lanes.ts` |
| c   | Worker files — job executors (`-worker.ts` suffix) | **Keep** `-worker` suffix. They execute jobs         |
| d   | Cline worker — MCP server                          | **Keep.** Already branded "cline"                    |

**Reasoning:** One rename: `worker-lanes.ts` → `job-lanes.ts`. The lane holds jobs, not workers. "Queue" already taken by `src/queue/` directory.

### 1.8 "story" → ✅ CONFIRMED

| #   | Concept                                | Decision                                                               |
| --- | -------------------------------------- | ---------------------------------------------------------------------- |
| a   | Story entity — RP session/save slot    | **Keep "story."** Primary meaning, user-facing                         |
| b   | Story phase — `StoryPhase = 'setup'    | 'kickoff'                                                              | 'story'` | **Tactical: `'story'` → `'active'`.** Fixes the "story phase is 'story'" tautology. Full `StoryPhase` concept flagged for redesign — it's really "interaction mode," and `'kickoff'` is a transient operation, not a stable mode. Defer to scene-management design pass |
| c   | Story nav section                      | **Keep "Story"** nav label. Fine                                       |
| d   | `stories.ts` route file (25+ handlers) | **Note: overloaded.** Covered by F-010 (route splitting). Not a rename |

**Reasoning:** Tactical fix on the phase name; strategic rethink deferred. The phase concept tracks "interaction mode" (OOC/editor ↔ IC play), not story lifecycle — future scene-management work will redesign this.

### 1.9 "config" → ✅ CONFIRMED

| #   | Concept                                                                        | Decision                                                                               |
| --- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| a-e | App defaults, agent resolution, agent overrides, model list, provider settings | **Keep.** All genuinely about configuration at different layers — no abuse of the term |
| f   | `memory-config.ts` (one boolean)                                               | **Deleted** in 1.1 purge                                                               |

**Reasoning:** Unlike other overloaded terms, "config" is used appropriately at every layer. No rename needed.

---

## 2. Synonym Drift

### 2.1 Play tab / toggles / story toggles / presets → ✅ CONFIRMED

| Current                                               | Canon                                                                                                        | Why                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `play-tab.ts` (backend)                               | **`display-preferences.ts`**                                                                                 | Font/labels/bubbles/colors — display configuration, not a tab           |
| `toggle-presets.ts` (backend)                         | **`generation-presets.ts`**                                                                                  | Length/mood/param/effort — generation parameter presets, not UI toggles |
| `storyToggles.tsx` + `playTabSettings.tsx` (frontend) | **Deferred to 5.1.** PascalCase renames. Two-systems-in-one-component split is refactoring, can address then |

**Reasoning:** Backend files named for what they hold, not UI location. Frontend complexity deferred.

### 2.2 Post / page / text / message / turn / entry → ✅ CONFIRMED

| Layer                                                               | Decision                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| DB: `page` / `text` tables                                          | **Keep.** Sound normalized design                                               |
| API: `/posts/:pageId` mismatch                                      | **Keep URL noun "posts," keep param `pageId`.** Fix docs to explain distinction |
| UI / docs / comments                                                | **Standardize on "post"** as user-facing term                                   |
| Internal types: `ChainPostEntry`, `LogEntry`, `PromptMessage`, etc. | **Keep.** Layer-specific representations — normal architecture                  |

**Reasoning:** Core issue is user-facing drift, not code structure. Fix the prose; don't rename DB tables.

### 2.3 Story-to-date naming variants → ℹ️ INFO ONLY

Standard case transforms across layers (file=kebab, DB=snake, types=PascalCase, prompts=UPPERCASE). Stack convention. No action.

### 2.4 Story / save / session / slot → ℹ️ INFO ONLY

Distinct concepts with coincidental overlap. Story=RP entity, save=story copy, session=auth, slot=concurrency. No action.

### 2.5 Space / tab / section → ℹ️ INFO ONLY

Distinct UI layers. Space=config blob, tab=settings UI, section=nav area. No action.

---

## 3. Legacy/Retired Terms → ℹ️ COVERED BY 1.1

3.1 `gen_extract`, 3.2 dead worker files, 3.3 `compress` job type — all purged in 1.1. No additional action.

---

## 4. Duplicated Type Definitions

### 4.1 AgentRole (3 definitions) → ✅ CONFIRMED

| Item                            | Decision                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------- |
| Canonical source                | **`model-config-store.ts`** — already the one `agent-config.ts` re-exports from |
| `agent-config-store.ts:5`       | **Delete duplicate.** Import from `model-config-store.ts`                       |
| `featherless-tag-ratings.ts:17` | **Delete duplicate.** Import from `model-config-store.ts`                       |

### 4.2 layout.ts collision → ℹ️ NO ACTION

`services/layout.ts` vs `routes/layout.ts` — directory distinguishes them. Standard Hono pattern (service + route adapter). Not a real collision.

---

## 5. File Naming Violations

### 5.1 + 5.2 → ✅ CONFIRMED

| Current                | →                        |
| ---------------------- | ------------------------ |
| `playTabSettings.tsx`  | `PlayTabSettings.tsx`    |
| `reasoningDisplay.tsx` | `ReasoningDisplay.tsx`   |
| `registry.tsx`         | `Registry.tsx`           |
| `storyToggles.tsx`     | `StoryToggles.tsx`       |
| `globalCssSettings.ts` | `global-css-settings.ts` |

**Note:** `storyToggles.tsx` and `playTabSettings.tsx` also have content-level issues from 2.1 — PascalCase fix is mechanical; content split deferred.

---

## 6. Semantic Ambiguity (F-027)

### 6.1 content-stamp.ts → ✅ CONFIRMED

**→ `content-fingerprint.ts`.** After 1.1 purge, only SHA-256 hashing remains. "Fingerprint" communicates the concept.

### 6.2–6.4 → ℹ️ COVERED

6.2 `memory-config.ts` → deleted (1.1). 6.3 `play-tab.ts` → `display-preferences.ts` (2.1). 6.4 `toggle-presets.ts` → `generation-presets.ts` (2.1).

### 6.5 worldbook-pc.ts → ✅ CONFIRMED

**→ `worldbook-assembly.ts`.** ~60% PC resolution, ~40% register/tone + CONTENT blocks + speech quotes. Assembles prompt components from worldbook entries — PC is one part.

### 6.6 kickoff.ts → ✅ CONFIRMED

**→ `story-transition.ts`.** Handles setup→story boundary: `resolveIcStartPageId()`, `finalizeSetup()`, `isOpeningPostPage()`. Actual kickoff orchestration lives in `pipeline-runner.ts`.
---

## 7. Service / Store / Utility Boundary Blur

### 7.1 story-to-date-admin.ts → ✅ CONFIRMED

**Merge into `story-to-date.ts`.** `removeStoryToDateSegment()` + `updateStoryToDateCoverageThroughPost()` are regular segment operations, not admin-only.

### 7.2 story-to-date-corpus.ts → ✅ CONFIRMED

**→ `story-to-date-engine.ts`.** Core algorithm module — merge, count, coverage, fold digestion, token estimation. "Engine" beats "corpus."

### 7.3 global-css.ts → ✅ CONFIRMED

**Move `src/services/global-css.ts` → `src/data/global-css.ts`.** It's `DEFAULT_GLOBAL_CSS` — a bundled data constant, not service logic.

### 7.4 db/time.ts → ✅ CONFIRMED

**Move `src/db/time.ts` → `src/lib/time.ts`.** `nowIso()` is a generic 3-line utility with no DB dependency.
---

## 8. Prefix / Grouping Inconsistency

### 8.1 horde-slots.ts → ✅ CONFIRMED

**Move `src/queue/horde-slots.ts` → `src/inference/horde-slots.ts`.** Inference concurrency tracking, not queue infrastructure.

### 8.2 Workers in services/ vs queue/ → ℹ️ NO ACTION

Architecturally valid. Workers are complex service code (inference, prompts, DB); pipeline-runner is the queue orchestrator. Split makes sense.

### 8.3 "Name" job types → ℹ️ NO ACTION

`story-name` + `segment-name` (renamed per 1.6) form a consistent pattern: `{entity}-name` = generate a name for X. No issue.
---

## 9. Frontend API Layer Naming

### 9.1 api-coordinator.ts → ✅ CONFIRMED

**→ `api-limiter.ts`.** Concurrency limiter (max 4 in-flight) + GET dedup. "Limiter" communicates the core behavior; "coordinator" is too vague.

---

## 10. Terminology Mismatch → ℹ️ MOSTLY COVERED

| Mismatch                                 | Status                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| `logbook` code vs "story" UI             | Resolved: 1.3 keeps logbook as book type, 1.8 keeps story as entity                     |
| `page` code vs "post" UI                 | Resolved: 2.2 — standardize UI on "post," keep page/text in DB                          |
| `icPostNumber` / `oocSessionStartPageId` | **Keep.** IC/OOC well-known RP acronyms, used consistently in code                      |
| `PC` in `worldbook-pc.ts`                | Resolved: 6.5 renames to `worldbook-assembly.ts` — PC acronym disappears from filenames |
| `genPackage` code vs "prose" docs        | Addressed in 11 (gen_ prefix — § opaquearchaic); internal DB column, not user-facing    |

---

## 11. Namespace Collisions

### 11.1 data/ vs src/data/ → ✅ CONFIRMED

| Current                                | →                                                         |
| -------------------------------------- | --------------------------------------------------------- |
| `data/` (root) — runtime SQLite + logs | **Keep.** Runtime data belongs at root                    |
| `src/data/` — bundled JSON defaults    | **→ `src/defaults/`.** Distinguishes from runtime `data/` |

### 11.2 Duplicate corrupted-tools/ → ✅ CONFIRMED

**Consolidate into root `corrupted-tools/`.** Files are about LLM tool call behavior — meta-information, not inference provider code.

- Move `src/inference/corrupted-tools/safe-todo-skill.md` → `corrupted-tools/safe-todo-skill.md`
- Move `src/inference/corrupted-tools/corrupted-toolcalls.txt` → `corrupted-tools/corrupted-toolcalls.txt`
- Delete `src/inference/corrupted-tools/`

### 11.3 src/experiments/ vs scripts/ → ✅ CONFIRMED

**Delete `src/experiments/story-to-date-corpus.ts`** (122-byte stub). Keep `scripts/`.
