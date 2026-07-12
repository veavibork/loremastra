# Lorepalace Evaluation Roadmap

Started 2026-07-12. Purpose: top-down project evaluation, discovery-oriented.
No code changes — findings only. Each item gets one pass; "needs separate session" is a valid finding.

---

## Evaluation Phases

- [x] **File structure consistency** — Does organization follow clinerules/stack.md's directory map? Any orphaned or misplaced files? → F-001 through F-011
- [x] **Large files** — Flag files >300 lines. Note rough size tiers (500+, 1000+, 2000+). → F-012 through F-017
- [x] **Dead code** — Unused exports, unreferenced files, leftover experiments folder contents. → F-018 through F-020c
- [x] **TODOs / FIXMEs** — Catalog inline markers and their locations. → F-021
- [x] **Dependency freshness** — Outdated packages, security advisories (`npm audit`), unused deps. → F-022
- [x] **Naming conventions** — File/module naming consistency across `src/` and `web/src/`, PascalCase/kebab-case/camelCase adherence vs clinerules claims. → F-023, F-024, F-027
- [x] **Linting / formatting gaps** — Backend has no linter, no formatter anywhere. Confirm and note impact. → F-025, F-026

### Phase 2: Backend Architecture

Timebox: read key structural files, form judgment. No line-by-line review.

- [ ] **Route / service / db layering** — Are routes doing business logic? Do services bypass stores? Is the layering clean?
- [ ] **pipeline-runner.ts complexity** — 59KB single file. What lives in it? Is it coherent or a god object?
- [ ] **Inference provider abstraction** — Featherless + Horde. Is the interface clean? Is adding a third provider straightforward?
- [ ] **Queue / lane design** — How does job scheduling work? Are worker lanes reasonable?
- [ ] **API contract shape** — REST-ish? Consistent patterns? Error response format?
- [ ] **Type safety** — Are Zod schemas comprehensive? Any `any` or `as` casts that undermine safety?
- [ ] **Error handling** — Pipeline failures, provider errors, DB errors. How are they surfaced to the client?

### Phase 3: Frontend Architecture

Timebox: read key files, form judgment.

- [ ] **Component separation** — Views vs reusable components vs hooks. Is the split clean?
- [ ] **State management** — No state library (per clinerules). How is state coordinated across views and with the server?
- [ ] **api.ts (34KB)** — Monolithic API layer. Is it organized internally? Duplication? Should it be split?
- [ ] **CSS conventions** — Config-driven layout, no pixel values (per clinerules). Adhered to?
- [ ] **Rendering patterns** — Any obvious re-render traps? Missing `key` props? Inline function/object creation in JSX?

### Phase 4: Documentation vs Reality

Timebox: spot-check key claims against code.

- [ ] **loremaster.md architecture section** — Does the described architecture match actual `src/` structure?
- [ ] **clinerules accuracy** — Do stack.md, frontend.md, database.md, dev-workflow.md reflect current state?
- [ ] **README accuracy** — Do commands, setup steps, and directory map match?
- [ ] **docs/roadmap.md cross-reference** — Which roadmap items are already implemented but not marked done? Which are stale?

### Phase 5: Synthesis

- [ ] **Cross-cutting findings** — Patterns that span phases (e.g., same anti-pattern in backend + frontend).
- [ ] **Severity ranking** — Critical / Should-fix / Nice-to-have / Informational.
- [ ] **Next-action recommendations** — Concrete "do this first" items, separate-session candidates.

---

## Resolved / Deferred

Items from the original evaluation scope that collapsed trivially or were deferred.
These will be revisited after the evaluation to discuss what _should_ be in place.

| Item                                | Status        | Current state                                                                               | Discussion needed                                       |
| ----------------------------------- | ------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Testing coverage (4.1)**          | Absent        | No test framework configured. Ad-hoc `scripts/test-*.ts` files only. No `npm test` command. | What test framework? What minimum coverage bar?         |
| **Test quality (4.2)**              | Absent        | No tests to evaluate.                                                                       | N/A until framework exists                              |
| **E2E coverage (4.3)**              | Absent        | No E2E tests.                                                                               | Playwright vs Cypress? Critical user journeys to cover? |
| **Security audit**                  | Deferred      | Out of scope for this evaluation.                                                           | Separate dedicated session                              |
| **Bundle size analysis (3.1)**      | Low-yield     | Frontend has 3 deps (React 19, react-dom, json-edit-react). Vite already treeshakes.        | Worth doing only if users report slow loads             |
| **Circular dependencies (2.3)**     | Tooling-gated | Needs madge/dependency-cruiser setup.                                                       | Separate session if warranted                           |
| **Database query efficiency (3.3)** | Tooling-gated | SQLite + better-sqlite3. Needs query plan analysis + profiling with real data.              | Separate session if performance issues observed         |
| **Re-render analysis (3.2)**        | Tooling-gated | Needs React DevTools profiling setup + interaction scripts.                                 | Separate session if UI sluggishness reported            |

---

## Findings Log

Findings are appended as each phase completes. Format:

### F-001: `web/src/assets/` documented but missing

**Phase:** 1. **Severity:** Info
**Files:** `.clinerules/stack.md:131`, `.clinerules/frontend.md:16`
**Finding:** Both stack.md and frontend.md claim `web/src/assets/` exists. It does not. No assets directory was ever created.
**Recommendation:** Either create the directory or remove the reference from docs.

### F-002: Diagnostic artifacts in `src/inference/`

**Phase:** 1. **Severity:** Info
**Files:** `src/inference/schema/`, `src/inference/corrupted-tools/`
**Finding:** Python scripts, JSON schemas, and GLM corruption analysis live under the inference source tree. They're not runtime code and aren't in the directory map.
**Recommendation:** Move diagnostic artifacts to `scripts/` or `docs/`. Keep `src/` for runtime code.

### F-003: Duplicate `corrupted-tools/` locations

**Phase:** 1. **Severity:** Info
**Files:** `corrupted-tools/omp-call-log.md`, `src/inference/corrupted-tools/`
**Finding:** Analysis output split across repo root and src/inference. Two homes for one concern.
**Recommendation:** Consolidate into one location.

### F-004: `bun.lock` present despite npm-only policy

**Phase:** 1. **Severity:** Info
**Files:** `bun.lock`
**Finding:** `stack.md` declares npm as the package manager, but a `bun.lock` file exists at root. Suggests a Bun experiment that wasn't cleaned up.
**Recommendation:** Delete `bun.lock` to avoid confusion, or formally support Bun + npm.

### F-005: `src/services/` is 35 flat files with no subdirectories

**Phase:** 1. **Severity:** Should-fix
**Files:** `src/services/*.ts` (35 files)
**Finding:** The directory conflates domain logic, read models, workers, configs, and small utilities with no organizational grouping. Clear thematic clusters exist (8 story-to-date files, 4 archive files, 4 memory files, 3 worldbook files) but aren't reflected in the directory structure. This is the most significant structural weakness.
**Recommendation:** Group into subdirectories by domain: `services/story-to-date/`, `services/archive/`, `services/memory/`, `services/worldbook/`. Move workers closer to `queue/`, read models to a `views/` or `queries/` dir.

### F-006: `src/services/compression.ts` + `compress-worker.ts` — likely dead code

**Phase:** 1. **Severity:** Should-fix
**Files:** `src/services/compression.ts` (2.1KB), `src/services/compress-worker.ts` (8.3KB)
**Finding:** Compression was retired 2026-07-04 per `loremaster.md` and `database.md`. These files may still be imported. Needs verification.
**Recommendation:** Check imports. If unreferenced, delete. If still referenced by legacy paths, remove references and delete.

### F-007: No `util/` or `lib/` directory — small cross-cutting files are scattered

**Phase:** 1. **Severity:** Nice-to-have
**Files:** `src/uuid.ts` (109B), `src/crypto.ts` (2.1KB), `src/db/time.ts` (72B), `src/services/global-css.ts` (902B)
**Finding:** Utility modules have no consistent home. `time.ts` lives in `db/` but has no database concern. `uuid.ts` and `crypto.ts` sit at `src/` root alongside `index.ts` and `config.ts`.
**Recommendation:** Create `src/lib/` or `src/util/` for cross-cutting utilities. Move `uuid.ts`, `crypto.ts`, `time.ts` there.

### F-008: `src/data/` vs root `data/` — namespace collision

**Phase:** 1. **Severity:** Nice-to-have
**Files:** `src/data/` (bundled JSON), `data/` (runtime SQLite + logs)
**Finding:** Two directories named `data/` serve completely different purposes (static assets vs runtime storage). Confusing for newcomers.
**Recommendation:** Rename `src/data/` → `src/assets/` or inline the JSON imports.

### F-009: `src/experiments/` — dead directory

**Phase:** 1. **Severity:** Info
**Files:** `src/experiments/story-to-date-corpus.ts` (122B stub)
**Finding:** A single 122-byte stub file in a dedicated directory. `scripts/` already exists for diagnostics.
**Recommendation:** Delete the directory and its stub, or relocate the experiment to `scripts/`.

### F-010: `src/prompts.ts` (21KB) at `src/` root level

**Phase:** 1. **Severity:** Nice-to-have
**Files:** `src/prompts.ts`
**Finding:** A 21KB data module sits alongside `index.ts` and `config.ts` at the `src/` root. It's a prompt catalog, not infrastructure — it doesn't belong at the top level.
**Recommendation:** Move to `src/services/prompts.ts` or `src/data/prompts.ts`.

### F-011: `queue/` vs `services/*-worker.ts` — fuzzy boundary

**Phase:** 1. **Severity:** Should-fix
**Files:** `src/queue/pipeline-runner.ts`, `src/services/*-worker.ts` (4 files)
**Finding:** `pipeline-runner.ts` lives in `queue/` and orchestrates services, but worker implementations (`story-to-date-worker.ts`, `archive-worker.ts`, `compress-worker.ts`, `story-to-date-fold-worker.ts`) live in `services/`. Either workers are queue consumers (→ `queue/`) or the pipeline runner is a service (→ `services/`). Current split is arbitrary.
**Recommendation:** Move worker files to `src/queue/` or create `src/workers/`. Keep the boundary clean.

### F-012: `pipeline-runner.ts` — 1,464 lines (god object risk)

**Phase:** 1. **Severity:** Should-fix
**Files:** `src/queue/pipeline-runner.ts`
**Finding:** The largest file in the codebase by a wide margin (~60KB on disk). It's the backbone of the job system — orchestrates pipeline execution, worker dispatch, concurrency, and retry logic. At this size, it's likely a god object that mixes orchestration, scheduling, and error recovery concerns.
**Recommendation:** Split into separate concerns: pipeline orchestration, job dispatch, retry/recovery. Deeper review needed (Phase 2).

### F-013: `StoryView.tsx` — 1,209 lines

**Phase:** 1. **Severity:** Should-fix
**Files:** `web/src/StoryView.tsx`
**Finding:** The main story view is the largest frontend file. View components at >1,000 lines typically mix rendering, event handling, and sub-component logic. Likely extractable sub-components (chat log, input bar, lore panel, etc.).
**Recommendation:** Extract named sub-components for each logical section of the story interface.

### F-014: `api.ts` — 1,024 lines (monolithic API layer)

**Phase:** 1. **Severity:** Should-fix
**Files:** `web/src/api.ts`
**Finding:** All frontend API calls in one file. At 1,024 lines, this is a monolith that mixes every resource (stories, agents, settings, archives, worldbook, account, queue, prompts, sessions, layout). No internal organization visible from line count alone.
**Recommendation:** Split by resource: `api/stories.ts`, `api/agents.ts`, etc. Keep a shared fetch wrapper. Deeper review in Phase 3.

### F-015: `routes/stories.ts` — 887 lines

**Phase:** 1. **Severity:** Should-fix
**Files:** `src/routes/stories.ts`
**Finding:** The largest route file. At 887 lines, route handlers for a single resource likely mix validation, business logic, and response formatting. Routes should be thin — this one probably isn't.
**Recommendation:** Verify whether business logic can be extracted to services. Deeper review in Phase 2.

### F-016: `story-to-date-corpus.ts` — 626 lines

**Phase:** 1. **Severity:** Info
**Files:** `src/services/story-to-date-corpus.ts`
**Finding:** The second-largest service file. Story-to-date is inherently complex (rolling recap generation), so high line count may be warranted. But worth checking for extractable sub-concerns.
**Recommendation:** Review in Phase 2 — may be coherent, may benefit from splitting corpus building vs segment management.

### F-017: `featherless.ts` — 549 lines

**Phase:** 1. **Severity:** Info
**Files:** `src/inference/featherless.ts`
**Finding:** The main inference provider integration. At 549 lines, it's the largest inference file. Provider integrations tend to accrete features (streaming, retry, model discovery, tag filtering). May be coherent, but worth checking for mixed concerns.
**Recommendation:** Review in Phase 2 for separation of API transport vs model discovery vs streaming logic.

### F-018: `archive-worker.ts` — dead code, never imported

**Phase:** 1. **Severity:** Should-fix
**Files:** `src/services/archive-worker.ts`
**Finding:** Zero imports across the entire codebase (src, web/src, scripts). Archive jobs are executed inline in `pipeline-runner.ts:dispatchWorkerJobs()`. This file exists alongside the active archive infrastructure but is completely unreferenced.
**Recommendation:** Delete the file. If it contains logic the pipeline runner needs, verify it's been inlined there first.

### F-019: `src/experiments/story-to-date-corpus.ts` — 122-byte stub

**Phase:** 1. **Severity:** Info
**Files:** `src/experiments/story-to-date-corpus.ts`, `scripts/story-to-date-experiment.ts`
**Finding:** A 122-byte re-export stub in a dedicated `experiments/` directory. Only imported by one script (`scripts/story-to-date-experiment.ts`). If that script is still in use, the stub belongs in `scripts/`. If not, both are dead.
**Recommendation:** Move the types inline into the experiment script, or delete both if the experiment is obsolete.

### F-020: Archives — code says active, `loremaster.md` says retired

**Phase:** 1. **Severity:** Should-fix
**Files:** `loremaster.md:37-38`, `src/services/archive.ts`, `src/services/archive-view.ts`, `src/services/archive-eligibility.ts`, `src/queue/pipeline-runner.ts:528,579`, `src/routes/stories.ts:318-334`
**Finding:** `loremaster.md` states decad archive blocks are retired (2026-07-04). But the pipeline runner actively dispatches `archive-name` jobs, the routes expose `/memory/backfill` and `/memory/enqueue` endpoints that "enqueue compress/archive jobs", the MCP dev server has tools for archive jobs, and `archive.ts` has a full enqueue/dispatch/requeue API. `story-db.ts`'s `purgeLegacyArchives` cancels archive jobs on open — but then the pipeline re-enqueues them. Either the retirement note is stale or the code wasn't fully decommissioned.
**Recommendation:** Resolve the contradiction. If archives are retired, remove the archive job types from the pipeline, routes, and MCP tools. If they're active, update `loremaster.md`.

### F-020b: `gen_extract` column — dormant scaffolding, not dead

**Phase:** 1. **Severity:** Info
**Files:** `src/db/story-schema.ts:44`, `src/db/text-store.ts:19,35,52,70`, `src/db/page-store.ts:15-16`, `src/services/content-stamp.ts:4,15`, `src/services/log-view.ts:14,65`, `src/services/memory-manifest.ts:147`
**Finding:** The `gen_extract` column remains in the schema with full store functions (`fillTextExtract`, `clearTextExtract`). Since `COMPRESSION_ENABLED = false`, the per-post compression path is dormant. The column is still referenced in read paths (log-view, memory-manifest, content-stamp) and `story-db.ts` runs a `gen_extract` backfill on every DB open. Per `loremaster.md`, this is "intentional migration scaffolding." But the retirement happened 8 days ago (2026-07-04) — the scaffolding has no documented sunset date and no cleanup plan. Accepting a prior doc statement as permanent justification for dead code is the same mistake as accepting the formatter "decision."
**Recommendation:** Add a `TODO(2026-08-01): Remove gen_extract column and related functions` marker. The scaffolding serves a purpose during the transition window but must not become permanent. If post-migration cleanup is already safe, accelerate the removal.

### F-020c: Naming collision — "compression" means three different things

**Phase:** 1. **Severity:** Should-fix
**Files:** `src/services/compression.ts`, `src/services/compress-worker.ts`, `src/services/story-to-date.ts`, `src/services/story-to-date-fold-worker.ts`, `src/services/memory-config.ts`, `src/queue/pipeline-runner.ts`
**Finding:** The word "compression" is overloaded across three distinct concepts: (1) retired per-post `gen_extract` compression (`COMPRESSION_ENABLED = false`, `postNeedsCompress`), (2) active story-to-date rolling recap generation (pipeline runner's `compress` job path, `enqueueEligibleCompressJobs`), and (3) deep-past story-to-date folding (`story-to-date-fold`, "recursive re-compression" per comments). The pipeline runner's `dispatchWorkerJobs` comment says "compress/archive jobs" when it dispatches story-to-date jobs. A new developer would be unable to tell which "compression" any given reference means.
**Recommendation:** Rename to disambiguate: `per-post-extract` (retired), `story-to-date-recap` (active), `story-to-date-fold` (active). Update `memory-config.ts` to reflect the retired status clearly. Update pipeline runner comments.

### F-021: Zero inline TODO/FIXME markers — deferred work tracked in natural-language comments

**Phase:** 1. **Severity:** Info
**Files:** `src/db/global-schema.ts:120`, `src/services/layout.ts:3`, `web/src/SettingsView.tsx:239`
**Finding:** No standard `TODO` or `FIXME` markers exist anywhere in the codebase. However, deferred work is recorded in natural-language comments instead. Three notable instances:

1. `global-schema.ts` references `web/src/error-titles.ts` — a file that "once exists" will map raw errors to friendly titles. This file does not exist yet.
2. `layout.ts` and `SettingsView.tsx` both note that drag-and-drop layout editing is "deferred" — matching the roadmap's "WYSIWYG layout editing" backlog item.
3. `pipeline-runner.ts` contains extensive "later" references for Horde job resolution ("come back later and check on this" — line 803).
   **Recommendation:** The absence of markers is neutral — comments serve the same purpose and are more descriptive. However, the `error-titles.ts` reference is a phantom dependency on a non-existent file. Either create it or remove the comment.

### F-022: Zero vulnerabilities, minor patch debt across both packages

**Phase:** 1. **Severity:** Info
**Files:** `package.json`, `web/package.json`
**Finding:** `npm audit` reports zero vulnerabilities in both packages. `npm outdated` shows only patch-level updates available (hono, vite, tsx, oxlint). Major bumps exist for `better-sqlite3` (11→12), `typescript` (backend 5→7, frontend 6→7), and `uuid` (11→14) but are optional and carry risk. Backend TypeScript 5.9.3 vs frontend TypeScript 6.0.3 is a minor version mismatch — likely accidental from separate update cycles.
**Recommendation:** Apply patch updates (`npm update`). Consider aligning TypeScript versions across packages. Defer major bumps (better-sqlite3 12, TS 7, uuid 14) to a dedicated session with regression testing.

### F-023: Four frontend components violate PascalCase convention

**Phase:** 1. **Severity:** Should-fix
**Files:** `web/src/playTabSettings.tsx`, `web/src/reasoningDisplay.tsx`, `web/src/registry.tsx`, `web/src/storyToggles.tsx`
**Finding:** The frontend convention (per `frontend.md`) requires PascalCase for component files. Four `.tsx` files use camelCase: `playTabSettings`, `reasoningDisplay`, `registry`, `storyToggles`. These are all components — `registry.tsx` exports `PageRegistry`, `storyToggles.tsx` exports `StoryToggles`, etc. The file names don't match the component names.
**Recommendation:** Rename to `PlayTabSettings.tsx`, `ReasoningDisplay.tsx`, `Registry.tsx`, `StoryToggles.tsx`. Update imports in `App.tsx` and any other consumers.

### F-024: Naming confusion — compression/compress inconsistency across related files

**Phase:** 1. **Severity:** Nice-to-have
**Files:** `src/services/compression.ts`, `src/services/compress-worker.ts`, `src/services/content-stamp.ts`, `src/services/memory-invalidation.ts`
**Finding:** The prefix is inconsistent: `compression.ts` uses "compression" while `compress-worker.ts` uses "compress". Related functions oscillate between `compress` and `compression`: `postNeedsCompress`, `COMPRESSION_ENABLED`, `markCompressValid`, `cancelPendingCompressJobs`. No clear rule for when to use which form.
**Recommendation:** Once the naming collision (F-020c) is resolved, standardize on a single prefix.

### F-025: Backend linter exists but clinerules claim it doesn't — 36 warnings

**Phase:** 1. **Severity:** Should-fix
**Files:** `.oxlintrc.json`, `package.json:lint`, `.clinerules/stack.md:90`, `.clinerules/testing.md`
**Finding:** `npm run lint` runs `oxlint src scripts` — the backend DOES have a linter. `stack.md` claims "no linter is configured" for the backend. The lint run produces 36 warnings: ~20 unused imports/variables, 4 unnecessary escapes, and dead code including `executeCompressJob()` (pipeline-runner:1129), `dropColumnIfExists()` (story-db:35), `ARCHIVE_MAX_ATTEMPTS`, `ARCHIVE_MAX_WORDS`, `truncateToWordLimit`. The `executeCompressJob` finding confirms the per-post compression path has dead code.
**Recommendation:** Fix the 36 warnings (mostly dead imports from refactors) and update `stack.md` to reflect that linting is configured. Consider making linting part of the `typecheck` command or adding a pre-commit hook.

### F-026: No formatter configured anywhere

**Phase:** 1. **Severity:** Nice-to-have
**Files:** _(none — absence of config)_
**Finding:** Neither backend nor frontend has a formatter (Prettier, biome, dprint). `stack.md:92` states "no formatter (e.g. Prettier) is configured in this repo" but the user does not recall making this a deliberate choice. With 36 lint warnings (F-025) and 3 files over 1,000 lines, a formatter would reduce formatting churn and make future diffs cleaner.
**Recommendation:** Add Prettier or biome with a minimal config. Run once across the codebase, then add a pre-commit hook (lint-staged or similar). Lower friction than the status quo.

### F-027: Semantic naming confusion — six files with unclear purpose from name alone

**Phase:** 1. **Severity:** Nice-to-have
**Files:** `src/services/content-stamp.ts`, `src/services/memory-config.ts`, `src/services/play-tab.ts`, `src/services/toggle-presets.ts`, `src/services/worldbook-pc.ts`, `src/services/kickoff.ts`
**Finding:** Several file names are semantically opaque:

- `content-stamp.ts` — "stamp" = SHA-256 fingerprint. `content-hash.ts` or `content-fingerprint.ts` would be clearer.
- `memory-config.ts` — 150 bytes, single boolean `COMPRESSION_ENABLED`. This is a feature flag, not a config. `feature-flags.ts` or inline the flag.
- `play-tab.ts` — 535 bytes, exports default settings for the play-tab UI space. `play-tab-defaults.ts` or `play-tab-settings.ts`.
- `toggle-presets.ts` — toggles for settings presets. `settings-presets.ts` would be clearer.
- `worldbook-pc.ts` — "PC" = Player Character. Not obvious from name. `worldbook-player-character.ts`.
- `story-to-date.ts` (orchestrator) vs `story-to-date-corpus.ts` (engine) — the split is reasonable but the names don't convey the distinction. Consider `story-to-date-orchestrator.ts` or adding a directory.
  **Recommendation:** Low priority, but rename opportunistically during the services/ reorganization (F-005).

---

### F-028: `stories.ts` acts as catch-all orchestrator — 30+ direct imports

**Phase:** 2. **Severity:** Should-fix
**Files:** `src/routes/stories.ts` (887 lines, 30+ imports)
**Finding:** The route imports from `db/` (15 stores), `services/` (18 services), `queue/` (pipeline-runner + job-events), and top-level `prompts.ts`. The story creation handler (POST `/`) creates a story, three books with parent relationships, an opening page, and hides it — inline orchestration, not thin delegation. The GET `/` handler iterates stories, opens each story DB, and merges stats. Other routes (`agents.ts`, `layout.ts`, etc.) are properly thin. `stories.ts` is the outlier — it's a catch-all coordinator for everything story-related.
**Recommendation:** Extract a `services/story-orchestrator.ts` that encapsulates story creation (with books + opening page), listing (with stats merge), and other multi-step workflows. Routes should validate input, call one orchestrator method, and format the response. This would shrink `stories.ts` from 887 lines to ~300 and cut imports by half.

### F-029: Services bypass store abstractions with raw SQL — 3 layering violations

**Phase:** 2. **Severity:** Should-fix
**Files:** `src/services/archive.ts:144`, `src/services/memory-manifest.ts:99`, `src/services/story-to-date.ts:61-75`
**Finding:** Three services write raw SQL for queries that have existing or easily-addable store functions:

- **Layering violation:** `archive.ts` does raw `UPDATE jobs` — `job-store.ts` should expose `cancelJobsForArchive(archiveId)`.
- **Layering violation:** `memory-manifest.ts` does raw `SELECT ... FROM book` — should use `getBookByType()` from `book-store.ts`.
- **Layering violation:** `story-to-date.ts` writes two raw `SELECT ... FROM jobs` queries — and imports `hasActiveJobForStoryToDate` from `job-store.ts` but duplicates it instead of extending the store.
  One raw-SQL hit is acceptable: `story-stats.ts` runs `SELECT COUNT(*) FROM worldbook_entry` — an analytical one-off query.
  **Recommendation:** Add `cancelJobsForArchive`, `hasPendingStoryToDateJob`, `hasPendingFoldJob` to `job-store.ts`. Fix `memory-manifest.ts` to use `getBookByType()`. Leave `story-stats.ts` as-is.

### F-030: Positive — services receive db handles, don't open connections

**Phase:** 2. **Severity:** Info (confirmation)
**Files:** `src/services/*` (all services)
**Finding:** Every service checked takes `db: Database.Database` as a parameter. The documented rule ("stores don't open connections; callers pass the handle") is consistently followed at the service layer too. Clean dependency inversion.
**Recommendation:** No action — preserve this pattern.

### F-031: `pipeline-runner.ts` — god object with 6 distinct concerns in 1,464 lines

**Phase:** 2. **Severity:** Should-fix
**Files:** `src/queue/pipeline-runner.ts` (1,464 lines, 59KB)
**Finding:** The file mixes six distinct concerns:

1. **Orchestration/scheduling** — scan loop, start/stop, story tracking
2. **Job dispatching** — worker dispatch, prose dispatch, concurrency gating
3. **Prompt assembly** — `buildProseHistory`, `buildSetupConversation`, `buildIcContextBlock`
4. **Job execution** — 10 `execute*` functions for 7 job types, spanning ~400 lines. Some delegate to services (`story-to-date-worker.ts`, `story-to-date-fold-worker.ts`) but others (`executeProseJob`, `executeSetupJob`, `executeSetupWorldbookJob`, `executeStoryNameJob`, `executeWorldbookCompactJob`) are inline.
5. **Inference transport** — `streamWithFallback` (~135 lines), `handleStreamingCancel`, Horde submit/resolve
6. **Content extraction** — `extractSummary`, `extractStoryName`, word-limit validators

Additionally, `executeCompressJob` (lines 1129-1240, 111 lines) is declared but never called — dead code flagged by oxlint (F-025).
**Recommendation:** Split into at least 3 files: (a) `pipeline-scheduler.ts` — scan loop, dispatch, job lifecycle; (b) `prose-executor.ts` — `executeProseJob` + `executeSetupJob` + `executeSetupWorldbookJob` + prompt assembly; (c) `inference-transport.ts` — `streamWithFallback` + Horde integration. Move content extraction helpers to `services/`. Delete `executeCompressJob` if confirmed dead.

### F-032: Inference providers — clean file separation, but pipeline hardcodes provider dispatch

**Phase:** 2. **Severity:** Should-fix
**Files:** `src/inference/featherless.ts`, `src/inference/horde.ts`, `src/queue/pipeline-runner.ts:605,719,774-779,978,1080,1162,1276,1351`
**Finding:** Provider files are cleanly separated (Featherless → streaming/completion, Horde → submit/poll). But the pipeline runner contains explicit provider branching: `if (provider === "horde")` (line 605), separate `executeHordeProseSubmit` vs Featherless `executeProseJob`, hardcoded `getDecryptedFeatherlessKey` and `getDecryptedHordeKey` calls scattered across 8 locations. There's no adapter or provider registry — adding a third provider means touching the pipeline runner in multiple places with new branches.
**Recommendation:** Extract a provider adapter that encapsulates: (a) API key retrieval, (b) the correct inference call for the provider (stream vs submit/poll), (c) error handling. The pipeline runner should call `provider.generate(messages, options)` without knowing which provider is behind it. Consider extracting `ChatMessage`/`ToolDefinition` to `inference/types.ts`.

### F-033: Queue/lane design — well-factored but dispatch lives in god object

**Phase:** 2. **Severity:** Info
**Files:** `src/queue/slots.ts`, `src/queue/worker-lanes.ts`, `src/queue/horde-slots.ts`, `src/queue/concurrency-feed.ts`, `src/queue/job-events.ts`
**Finding:** The queue subsystem has five well-named files handling distinct concerns: slot acquisition, worker lane limits, Horde-specific slots, concurrency feeding, and job event pub/sub. The design is sound: prose jobs get one lane, worker jobs get parallel dispatch up to `WORKER_THREADS`, Horde jobs poll asynchronously. The issue is that dispatch logic (`dispatchWorkerJobs`, `dispatchProseJob`) lives in `pipeline-runner.ts` (F-031) rather than in these queue files, making the pipeline-runner the bottleneck.
**Recommendation:** Once `pipeline-runner.ts` is split (F-031), move dispatch functions into `queue/` where they belong.

### F-034: API contract — consistent error format, but validation is manual (no Zod)

**Phase:** 2. **Severity:** Nice-to-have
**Files:** `src/routes/*.ts`
**Finding:** Error responses follow a consistent `{ error: string }` format with appropriate HTTP status codes. However, request validation is entirely manual — body parsing uses `as` casts (`const body = await c.req.json() as { name?: string }`) rather than Zod schemas. The MCP tools (`dev-server.ts`, `cline-worker.ts`) do use Zod for input validation, but the HTTP routes don't. This means malformed bodies pass through and fail at the store/service layer with less helpful errors.
**Recommendation:** Add Zod schemas to route inputs, especially for POST/PATCH endpoints. Use Hono's built-in Zod validation middleware (`zValidator`). Start with `settings-spaces.ts` and `layout.ts` as low-risk candidates.

### F-035: Type safety — minimal unsafe casts, good strict-mode foundation

**Phase:** 2. **Severity:** Info (confirmation)
**Files:** `src/services/layout.ts:255,275`
**Finding:** Only two `as unknown` casts exist in the entire backend, both in `layout.ts` for version migration (converting `LayoutConfigV1` to `LayoutConfigData`). No `as any` casts found. Both `tsconfig.json` files use `strict: true`. The `as` casts for request body parsing in routes are structural typing (TypeScript trusts the type annotation) — not ideal but conventional for Hono.
**Recommendation:** No action for current code. When adding Zod validation (F-034), the body `as` casts become runtime-verified and the concern is eliminated.

### F-036: Error handling — basic but consistent, no centralized handler

**Phase:** 2. **Severity:** Nice-to-have
**Files:** `src/routes/*.ts`, `src/queue/pipeline-runner.ts`
**Finding:** Error responses are 100% consistent: every route uses `{ error: string }`. Success responses are ad-hoc per endpoint (some include `ok: true`, some don't) — fine for a single-client API. However: (1) The `err instanceof Error ? err.message : String(err)` pattern appears ~15 times — extractable; (2) No global `onError` handler exists — an uncaught exception could leak a stack trace; (3) Pipeline errors flow through a completely separate channel (SSE job events via `publishError`/`publishCancelled`), not REST — this is by design but means error handling has two different mechanisms to maintain.
**Recommendation:** Extract `formatError(err: unknown): string` to `src/lib/errors.ts`. Add a Hono `onError` middleware. Document the two error channels (REST vs SSE) in a clinerule.

### F-037: Nav + registry pattern — clean multi-panel architecture

**Phase:** 3. **Severity:** Info (confirmation)
**Files:** `web/src/Nav.tsx`, `web/src/registry.tsx`, `web/src/panel-types.ts`
**Finding:** Nav renders a tab-bar + resizable column layout. Panel components are resolved via a compile-time `REGISTRY` lookup table in `registry.tsx` — clean plugin pattern. `panel-types.ts` defines the shared `PanelProps` interface that all panels receive. `ClaimGate.tsx` is isolated. `EntryContent.tsx`, `ButtonContainerRow.tsx`, `useStoryLogScroll.ts`, `useVisualViewport.ts` are clean reusable components/hooks.
**Recommendation:** No action — preserve this pattern.

### F-038: `StoryView.tsx` — frontend god component (1,209 lines)

**Phase:** 3. **Severity:** Should-fix
**Files:** `web/src/StoryView.tsx`
**Finding:** StoryView is the frontend equivalent of pipeline-runner.ts. It handles: chat log rendering, AutoGrowTextarea composer with keyboard shortcuts, toolbar with 80-line `getButtonProps` switch statement, mode switching (IC/OOC), kickoff, undo/redo, retry/continue, streaming job subscription, guidance editing, toggles (length/mood/param/model/effort/reasoning), fork, and hidden pending job tracking. All in one file. Multi-user support would amplify this: each user gets their own story + state, but the component complexity per-story is unchanged — fixing this now is proactive, not premature.
**Recommendation:** (1) Extract sub-components: `PlayToolbar.tsx` (toolbar + 80-line switch), `Composer.tsx` (textarea + submit + keyboard), `ChatLog.tsx` (scrollable log). (2) Replace ~15 scattered `useState` calls with a single `useReducer` — the implicit state machine (busy/editing/mode/phase/streaming interactions) becomes explicit, testable, and prevents impossible combinations. No library needed — `useReducer` is built into React and per-user isolation means no cross-user state to manage. (3) Move the resulting reducer + action dispatch into `useStoryController.ts`.

### F-039: `api.ts` — monolithic API layer with 65 exports, organized by resource

**Phase:** 3. **Severity:** Should-fix
**Files:** `web/src/api.ts` (1,024 lines), `web/src/api-coordinator.ts` (2KB)
**Finding:** 65 exported functions in one flat file covering every resource: sessions, account, layout, settings, prompts, jobs, models, stories, story-to-date, archives, posts, position, worldbook. `api-coordinator.ts` cleanly isolates the 409/superseded coordination layer. But the API surface itself has no internal grouping — adding a new endpoint means finding the right spot in a 1,000-line file.
**Recommendation:** Split by resource: `api/sessions.ts`, `api/stories.ts`, `api/agents.ts`, etc. Keep `api-coordinator.ts` as the shared fetch wrapper. The split mirrors the backend's `routes/` structure naturally.

### F-040: Flat `web/src/` — all views/components/hooks/CSS at one level

**Phase:** 3. **Severity:** Nice-to-have
**Files:** `web/src/*.tsx` (49 files at one level)
**Finding:** Unlike the backend which has subdirectories, the frontend places all 49 source files at `web/src/` with no `views/`, `components/`, or `hooks/` directories. Views (`*View.tsx`), reusable components (`ButtonContainerRow`, `EntryContent`, `ClaimGate`), hooks (`use*`), and utilities (`api.ts`, `toast.ts`) share one flat namespace. The naming conventions disambiguate (PascalCase = component, `use*` = hook, kebab-case = utility) but a directory structure would help at this file count.
**Recommendation:** Create `web/src/views/`, `web/src/components/`, `web/src/hooks/`, `web/src/api/`. This becomes natural once `api.ts` is split (F-039) and StoryView is decomposed (F-038).

### F-041: CSS conventions — zero pixel values, config-driven layout adhered to

**Phase:** 3. **Severity:** Info (confirmation)
**Files:** `web/src/*.css` (17 files)
**Finding:** A grep for `\dpx` across all CSS files returned zero matches. Layout is driven by percentages, flex, grid, and `rem`. `globalCssSettings.ts` injects CSS custom properties at runtime for user-configurable theming. The `ButtonContainerRow` component + `layoutUtils.ts` implement the config-driven toolbar system. The documented conventions are consistently followed.
**Recommendation:** No action — preserve this pattern.

### F-042: Rendering patterns — `key` props and memoization need deeper review

**Phase:** 3. **Severity:** Needs separate session
**Files:** `web/src/StoryView.tsx`, `web/src/ArchivesView.tsx`
**Finding:** A quick scan shows `key` props are present on list renders (chat entries, archive rows). But StoryView has inline function creation in JSX (e.g., `onKeyDown={(e) => {...}}`, `getButtonProps={(id) => {...}}`) which creates new function references on every render. The `useMemo`/`useCallback` usage is minimal. Without React DevTools profiling, determining whether these cause measurable re-render issues is speculative.

### F-043: `loremaster.md` — two claims contradicted by code

**Phase:** 4. **Severity:** Should-fix
**Files:** `loremaster.md:37-38`
**Finding:** Two documented claims don't match the codebase:

1. "Decad archive blocks are retired" (line 38) — but pipeline-runner dispatches archive-name jobs, archive.ts has full enqueue/requeue API, routes expose /memory/backfill and /memory/enqueue for archives. Previously F-020.
2. "Code and DB columns may remain for migration compatibility; they are not enqueued, not assembled, and are purged on story DB open" — but gen_extract functions are called in read paths (log-view, memory-manifest) and story-db.ts runs backfills on open. Previously F-020b.
   The architecture description otherwise matches src/ structure well.
   **Recommendation:** Either recommission archives (update loremaster.md) or fully decommission them (remove from pipeline, routes, MCP tools). For gen_extract, add a sunset TODO (F-020b).

### F-044: `.clinerules/stack.md` — two stale claims

**Phase:** 4. **Severity:** Should-fix
**Files:** `.clinerules/stack.md:90-92`
**Finding:**

1. "Backend: no linter is configured" (line 90) — npm run lint runs oxlint src scripts and produces 36 warnings. F-025.
2. "No formatter (e.g. Prettier) is configured in this repo" (line 92) — user does not recall this as a deliberate choice. F-026.
   **Recommendation:** Update stack.md: (a) oxlint is configured for both backend and frontend; (b) formatter status is TBD, not settled.

### F-045: `docs/roadmap.md` cross-reference — 12 items match, 11 are new

**Phase:** 4. **Severity:** Info
**Files:** `docs/roadmap.md`
**Finding:** The existing roadmap captures several problems we independently discovered: input bar UI, WYSIWYG layout, MemoryView stale copy, config/prompts editor, settings profiles. Our new findings not in the existing roadmap include: flat services/ structure (F-005), fuzzy queue/services boundary (F-011), compression naming collision (F-020c), lint warnings (F-025), formatter (F-026), route orchestrator extraction (F-028), store bypass (F-029), pipeline-runner god object (F-031), provider branching (F-032), StoryView decomposition (F-038), api.ts split (F-039).
**Recommendation:** Merge new findings into existing roadmap as backlog items, or keep evaluation-roadmap.md as standalone audit.

### F-046: Cross-cutting pattern — god objects in both tiers

**Phase:** 5. **Severity:** Should-fix (synthesis)
**Finding:** The same anti-pattern appears in both frontend and backend: a single file that absorbs all coordination responsibility. `pipeline-runner.ts` (1,464 lines, 6 concerns) and `StoryView.tsx` (1,209 lines, 10+ responsibilities) are structural mirrors. Both grew organically as features were added to the most central file. The fix is the same in both cases: extract sub-concerns into focused modules, leaving the original as a thin coordinator.
**Related:** F-031, F-038

### F-047: Cross-cutting pattern — monolithic resource files

**Phase:** 5. **Severity:** Should-fix (synthesis)
**Finding:** `web/src/api.ts` (1,024 lines, 65 exports) and `src/routes/stories.ts` (887 lines, 30+ imports) are both monolithic resource files. api.ts groups everything by endpoint, stories.ts groups everything by URL prefix. Both need splitting by sub-resource. The backend already has the pattern (`routes/agents.ts`, `routes/layout.ts` are properly thin) — stories.ts is the outlier. The frontend needs the same treatment: `api/stories.ts`, `api/agents.ts`, etc.
**Related:** F-014, F-015, F-028, F-039

### F-048: Cross-cutting pattern — flat directories at scale

**Phase:** 5. **Severity:** Nice-to-have (synthesis)
**Finding:** `src/services/` (35 files) and `web/src/` (49 files) are both flat directories that have outgrown their original design. Both have clear thematic clusters that aren't reflected in the filesystem. The naming conventions do the organizational work that directories should do. Adding subdirectories is low-risk and high-clarity.
**Related:** F-005, F-040

---

## Severity Ranking

### Should-fix (18 distinct findings)

Structural problems with concrete fixes. Three earlier-phase findings (F-012, F-013, F-015) are superseded by deeper analysis in F-031, F-038, F-028 and not double-counted. Similarly F-014 is superseded by F-039.

1. **F-031** — pipeline-runner.ts god object (1,464 lines, 6 concerns)
2. **F-038** — StoryView.tsx god component (1,209 lines, 10+ responsibilities)
3. **F-028** — stories.ts catch-all orchestrator (887 lines, 30+ imports)
4. **F-020** — archives: docs say retired, code says active
5. **F-020c** — compression naming collision (3 meanings, 1 word)
6. **F-032** — provider branching hardcoded in pipeline-runner
7. **F-005** — flat services/ directory (35 files, no subdirectories)
8. **F-011** — fuzzy queue vs services workers boundary
9. **F-039** — api.ts monolithic (1,024 lines, 65 exports)
10. **F-025** — 36 unfixed lint warnings
11. **F-044** — stack.md stale claims (linter, formatter)
12. **F-043** — loremaster.md stale claims (archives, gen_extract)
13. **F-026** — no formatter configured
14. **F-029** — 3 services bypass stores with raw SQL
15. **F-018** — archive-worker.ts dead code (zero imports)
16. **F-023** — 4 frontend PascalCase violations
17. **F-006** — compression/compress-worker dead or dormant
18. **F-046** — cross-cutting: god objects in both tiers (synthesis)

### Nice-to-have (10 findings)

Clear improvements without structural urgency:
F-007 (util/lib dir), F-008 (data/ collision), F-010 (prompts.ts location), F-024 (prefix consistency), F-027 (semantic naming), F-034 (Zod validation), F-036 (error handler), F-040 (flat web/src/), F-047, F-048 (synthesis patterns)

### Info / Confirmation (14 findings)

F-001-F-004 (minor nits), F-009 (dead experiments dir), F-016-F-017 (large but coherent), F-019 (experiments stub), F-020b (gen_extract scaffolding), F-021 (no TODOs), F-022 (zero vulns), F-030 (db handle pattern), F-033 (queue design sound), F-035 (type safety), F-037 (nav+registry clean), F-041 (CSS conventions), F-045 (roadmap cross-ref)

### Separate session (1 finding)

F-042 — React re-render profiling needs DevTools

---

## Next-Action Recommendations

### Do first (this week)

1. Fix 36 lint warnings (F-025) — mechanical, zero risk
2. Delete archive-worker.ts (F-018) — confirmed dead
3. Add Prettier or biome (F-026) — run once, add pre-commit hook
4. Resolve archives contradiction (F-020) — recommission or decommission
5. Fix 4 PascalCase component names (F-023)

### Do next (this month)

6. Split pipeline-runner.ts (F-031) — highest-impact refactor
7. Split StoryView.tsx + add useReducer (F-038)
8. Split api.ts by resource (F-039)
9. Extract story-orchestrator.ts (F-028)
10. Fix store bypasses — 3 raw SQL → store functions (F-029)
11. Add provider adapter (F-032)
12. Group services/ into subdirectories (F-005)

### Do later (when convenient)

13. Rename for clarity (F-020c, F-024, F-027)
14. Add Zod validation to routes (F-034)
15. Add global error handler (F-036)
16. Create web/src/ subdirectories (F-040)
17. Create src/lib/ for utilities (F-007)
18. Apply npm patch updates (F-022)
