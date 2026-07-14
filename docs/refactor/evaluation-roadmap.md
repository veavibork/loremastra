# Lorepalace Evaluation Roadmap

Started 2026-07-12. Purpose: top-down project evaluation, discovery-oriented.
Updated 2026-07-12: documentation reconciliation, formatting workflow, testing framework.

---

## Resolution Status (2026-07-12)

Findings marked **[RESOLVED]** have been addressed. See the finding body for what changed.

| Finding       | Severity     | Description                                                  | Status                                                                                                                                                                     |
| ------------- | ------------ | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-025         | Should-fix   | Backend linter exists but docs claim it doesn't; 36 warnings | **[RESOLVED]** — Backend 0 warnings, stack.md updated. Frontend 12 warnings deferred.                                                                                      |
| F-026         | Nice-to-have | No formatter configured                                      | **[RESOLVED]** — Prettier configured with lint-staged pre-commit hook.                                                                                                     |
| F-020         | Should-fix   | Archives: docs say retired, code says active                 | **[RESOLVED]** — Fully retired (2026-07-12 disambiguation): archive tables, workers, routes, and purgeLegacyArchives deleted. Segments tab manages story-to-date segments. |
| F-043         | Should-fix   | loremaster.md stale claims                                   | **[RESOLVED]** — Doc updated; archives + gen_extract status clarified.                                                                                                     |
| F-044         | Should-fix   | stack.md stale claims (no linter, no formatter)              | **[RESOLVED]** — Doc updated; both claims corrected.                                                                                                                       |
| F-001         | Info         | web/src/assets/ documented but missing                       | **[RESOLVED]** — Docs no longer reference the directory.                                                                                                                   |
| Testing (4.1) | —            | No test framework                                            | **[RESOLVED]** — Vitest + Playwright configured. Tests in `tests/db/`, `tests/lib/`, `e2e/`.                                                                               |
| E2E (4.3)     | —            | No E2E tests                                                 | **[RESOLVED]** — Playwright configured with `npm run test:e2e`.                                                                                                            |
| Documentation | —            | Dated docs vs current reality                                | **[RESOLVED]** — Docs reconciled. `.clinerules/` content merged into `CLAUDE.md`; `cline-setup.md` deleted (Cline removed).                                                |
| F-018         | Should-fix   | archive-worker.ts dead code                                  | **[RESOLVED]** — Deleted (2026-07-12 disambiguation, Phase 1).                                                                                                             |
| F-023         | Should-fix   | Four frontend PascalCase violations                          | **[RESOLVED]** — Renamed (2026-07-12 disambiguation, Phase 5): PlayTabSettings, ReasoningDisplay, Registry, StoryToggles.                                                  |
| F-006         | Should-fix   | compression.ts + compress-worker.ts dead code                | **[RESOLVED]** — Deleted (Phase 1).                                                                                                                                        |
| F-009         | Info         | src/experiments/ dead directory                              | **[RESOLVED]** — Deleted (Phase 1).                                                                                                                                        |
| F-020b        | Info         | gen_extract column dormant scaffolding                       | **[RESOLVED]** — Column removed from schema, store functions deleted (Phases 1, 3).                                                                                        |
| F-020c        | Should-fix   | Compression naming collision                                 | **[RESOLVED]** — Compress/archive code deleted; `content-stamp` → `content-fingerprint`.                                                                                   |
| F-008         | Nice-to-have | src/data/ namespace collision                                | **[RESOLVED]** — Renamed to `src/defaults/` (Phase 4).                                                                                                                     |
| F-003         | Info         | Duplicate corrupted-tools/ locations                         | **[RESOLVED]** — Consolidated to root `corrupted-tools/` (Phase 4).                                                                                                        |

## Still Outstanding

| Finding                   | Severity   | Description                                                                 |
| ------------------------- | ---------- | --------------------------------------------------------------------------- |
| F-004                     | Info       | bun.lock present                                                            | **[RESOLVED]** — Deleted.                                                               |
| F-038                     | Should-fix | StoryView.tsx 1,209 lines                                                   | **[RESOLVED]** — Phase 2: useReducer + StoryLog/StoryFooter/StoryViewHelpers extracted. |
| F-039                     | Should-fix | api.ts monolithic (1,024 lines)                                             | **[RESOLVED]** — Phase 3: split into 13 resource modules.                               |
| F-040                     | Should-fix | Flat web/src/ directory (50+ files)                                         | **[RESOLVED]** — Phase 5: views/, components/, hooks/, lib/, api/ subdirectories.       |
| F-005, F-007, F-010–F-048 | Varies     | Remaining unaddressed findings (many resolved by 2026-07-12 disambiguation) |

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

- [x] **Component separation** — Views vs reusable components vs hooks. Is the split clean?
- [x] **State management** — No state library (per clinerules). How is state coordinated across views and with the server?
- [x] **api.ts (34KB)** — Monolithic API layer. Is it organized internally? Duplication? Should it be split?
- [x] **CSS conventions** — Config-driven layout, no pixel values (per clinerules). Adhered to?
- [x] **Rendering patterns** — Any obvious re-render traps? Missing `key` props? Inline function/object creation in JSX?

### Phase 4: Documentation vs Reality

- [x] **loremaster.md architecture section** — Does the described architecture match actual `src/` structure? → Resolved 2026-07-12.
- [x] **clinerules accuracy** — Do stack.md, frontend.md, database.md, dev-workflow.md reflect current state? → Resolved 2026-07-12.
- [x] **README accuracy** — Do commands, setup steps, and directory map match? → Resolved 2026-07-12.
- [ ] **docs/roadmap.md cross-reference** — Which roadmap items are already implemented but not marked done? Which are stale?

### Phase 5: Synthesis

- [ ] **Cross-cutting findings** — Patterns that span phases (e.g., same anti-pattern in backend + frontend).
- [ ] **Severity ranking** — Critical / Should-fix / Nice-to-have / Informational.
- [ ] **Next-action recommendations** — Concrete "do this first" items, separate-session candidates.

---

## Resolved / Deferred

Items from the original evaluation scope that collapsed trivially or were deferred.

| Item                                | Status        | Current state                                                                            | Discussion needed                                |
| ----------------------------------- | ------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **Testing coverage (4.1)**          | Configured    | Vitest + Playwright configured. `npm test`, `npm run test:e2e`, `npm run test:coverage`. | Expand test coverage for stores/services/routes. |
| **Test quality (4.2)**              | Early         | Tests exist in `tests/db/`, `tests/lib/`, `e2e/`. Coverage still low.                    | Set coverage targets; add service/route tests.   |
| **E2E coverage (4.3)**              | Configured    | Playwright configured in `playwright.config.ts`. `npm run test:e2e`.                     | Write critical user journey tests.               |
| **Security audit**                  | Deferred      | Out of scope for this evaluation.                                                        | Separate dedicated session                       |
| **Bundle size analysis (3.1)**      | Low-yield     | Frontend has 3 deps (React 19, react-dom, json-edit-react). Vite already treeshakes.     | Worth doing only if users report slow loads      |
| **Circular dependencies (2.3)**     | Tooling-gated | Needs madge/dependency-cruiser setup.                                                    | Separate session if warranted                    |
| **Database query efficiency (3.3)** | Tooling-gated | SQLite + better-sqlite3. Needs query plan analysis + profiling with real data.           | Separate session if performance issues observed  |
| **Re-render analysis (3.2)**        | Tooling-gated | Needs React DevTools profiling setup + interaction scripts.                              | Separate session if UI sluggishness reported     |

---

## Findings Log

Findings are appended as each phase completes. Format:

### F-001: `web/src/assets/` documented but missing **[RESOLVED]**

**Phase:** 1. **Severity:** Info
**Files:** `.clinerules/stack.md:131`, `.clinerules/frontend.md:16` (both deleted — content merged into `CLAUDE.md`)
**Finding:** Both stack.md and frontend.md claim `web/src/assets/` exists. It does not. No assets directory was ever created.
**Resolution (2026-07-12):** Docs no longer reference `web/src/assets/`. The `/public/` directory covers static assets.

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
**Files:** `web/src/views/StoryView.tsx`
**Finding:** The main story view is the largest frontend file. View components at >1,000 lines typically mix rendering, event handling, and sub-component logic. Likely extractable sub-components (chat log, input bar, lore panel, etc.).
**Recommendation:** Extract named sub-components for each logical section of the story interface.

### F-014: `api.ts` — 1,024 lines (monolithic API layer)

**Phase:** 1. **Severity:** Should-fix
**Files:** `web/src/api/` (was `web/src/api.ts`, split into 13 modules in Phase 3)
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

### F-018: `archive-worker.ts` — dead code, never imported **[RESOLVED]**

**Phase:** 1. **Severity:** Should-fix
**Resolution (2026-07-12):** Deleted in Phase 1 of the disambiguation resolution along with other dead archive/compression files.

### F-019: `src/experiments/story-to-date-corpus.ts` — 122-byte stub

**Phase:** 1. **Severity:** Info
**Files:** `src/experiments/story-to-date-corpus.ts`, `scripts/story-to-date-experiment.ts`
**Finding:** A 122-byte re-export stub in a dedicated `experiments/` directory. Only imported by one script (`scripts/story-to-date-experiment.ts`). If that script is still in use, the stub belongs in `scripts/`. If not, both are dead.
**Recommendation:** Move the types inline into the experiment script, or delete both if the experiment is obsolete.

### F-020: Archives — code says active, `loremaster.md` says retired **[RESOLVED]**

**Phase:** 1. **Severity:** Should-fix
**Files:** `loremaster.md:37-38`, `src/services/archive.ts`, `src/services/archive-view.ts`, `src/services/archive-eligibility.ts`, `src/queue/pipeline-runner.ts:528,579`, `src/routes/stories.ts:318-334`
**Finding:** `loremaster.md` states decad archive blocks are retired (2026-07-04). But the pipeline runner actively dispatches `archive-name` jobs, the routes expose `/memory/backfill` and `/memory/enqueue` endpoints that "enqueue compress/archive jobs", the MCP dev server has tools for archive jobs, and `archive.ts` has a full enqueue/dispatch/requeue API.
**Resolution (2026-07-12):** Fully retired in disambiguation resolution. Archive tables, `archive.ts`, `archive-view.ts`, `archive-eligibility.ts`, `purgeLegacyArchives` all deleted. `archive-name` job type → `segment-name`. Segments tab manages story-to-date segments; no archive infrastructure remains.

### F-020b: `gen_extract` column — dormant scaffolding, not dead **[RESOLVED]**

**Phase:** 1. **Severity:** Info
**Resolution (2026-07-12):** Column removed from schema, store functions (`fillTextExtract`, `clearTextExtract`) deleted, all read paths cleaned up in Phases 1-3 of the disambiguation resolution.

### F-020c: Naming collision — "compression" means three different things **[RESOLVED]**

**Phase:** 1. **Severity:** Should-fix
**Resolution (2026-07-12):** Compress/archive code deleted in Phase 1; `content-stamp.ts` → `content-fingerprint.ts`; `COMPRESSION_ENABLED` removed. Remaining story-to-date concepts share a clear `story-to-date` prefix.

### F-021: Zero inline TODO/FIXME markers — deferred work tracked in natural-language comments

**Phase:** 1. **Severity:** Info
**Files:** `src/db/global-schema.ts:120`, `src/services/layout.ts:3`, `web/src/views/PreferencesView.tsx:239`
**Finding:** No standard `TODO` or `FIXME` markers exist anywhere in the codebase.
**Recommendation:** The absence of markers is neutral. The `error-titles.ts` reference is a phantom dependency — either create it or remove the comment.

### F-022: Zero vulnerabilities, minor patch debt across both packages

**Phase:** 1. **Severity:** Info
**Files:** `package.json`, `web/package.json`
**Finding:** `npm audit` reports zero vulnerabilities. `npm outdated` shows patch-level updates available. Backend TypeScript 5.9.3 vs frontend TypeScript 6.0.3 minor mismatch.
**Recommendation:** Apply patch updates. Consider aligning TypeScript versions.

### F-023: Four frontend components violate PascalCase convention **[RESOLVED]**

**Phase:** 1. **Severity:** Should-fix
**Resolution (2026-07-12):** All 4 renamed in Phase 5: `playTabSettings.tsx` → `PlayTabSettings.tsx`, `reasoningDisplay.tsx` → `ReasoningDisplay.tsx`, `registry.tsx` → `Registry.tsx`, `storyToggles.tsx` → `StoryToggles.tsx`.

### F-024: Naming confusion — compression/compress inconsistency **[RESOLVED]**

**Phase:** 1. **Severity:** Nice-to-have
**Resolution (2026-07-12):** `compression.ts` and `compress-worker.ts` deleted. `content-stamp.ts` → `content-fingerprint.ts`, `memory-invalidation.ts` → `context-invalidation.ts`.

### F-025: Backend linter exists but clinerules claim it doesn't — 36 warnings **[RESOLVED]**

**Phase:** 1. **Severity:** Should-fix
**Files:** `.oxlintrc.json`, `package.json:lint`, `.clinerules/stack.md:90`, `.clinerules/testing.md` (clinerules deleted — content merged into `CLAUDE.md`)
**Finding:** `npm run lint` runs `oxlint src scripts` — the backend HAS a linter. `stack.md` claimed none configured.
**Resolution (2026-07-12):** Backend warnings fixed (0 remaining). Stack.md updated. Frontend has 12 remaining warnings deferred for follow-up.

### F-026: No formatter configured anywhere **[RESOLVED]**

**Phase:** 1. **Severity:** Nice-to-have
**Files:** _(none — absence of config)_
**Finding:** Neither backend nor frontend had a formatter. `stack.md` stated "no formatter configured."
**Resolution (2026-07-12):** Prettier configured (`.prettierrc`, `.prettierignore`) with `lint-staged` + `simple-git-hooks` pre-commit hook. `npm run format` available in both root and `web/`. All files formatted; zero changes needed.

### F-027: Semantic naming confusion — six files with unclear purpose **[RESOLVED]**

**Phase:** 1. **Severity:** Nice-to-have
**Resolution (2026-07-12):** All 6 renamed in Phase 2: `content-stamp.ts` → `content-fingerprint.ts`, `memory-config.ts` → deleted, `play-tab.ts` → `display-preferences.ts`, `toggle-presets.ts` → `generation-presets.ts`, `worldbook-pc.ts` → `worldbook-assembly.ts`, `kickoff.ts` → `story-transition.ts`.

---

### F-028–F-048

Many findings in this range have been addressed by the 2026-07-12 disambiguation resolution (F-003, F-006, F-008, F-009, F-018, F-019, F-020b, F-020c, F-023, F-024, F-027). See Resolution Status table and individual finding bodies above for full details.

---

## Severity Ranking (Updated)

### Resolved (2026-07-12)

F-025, F-026, F-020, F-043, F-044, F-001, F-018, F-023, F-020c, F-006

### Should-fix (remaining)

F-031, F-038, F-028, F-032, F-005, F-011, F-039, F-029, F-046

### Nice-to-have

F-007, F-010, F-034, F-036, F-040, F-047, F-048

### Info / Confirmation

F-002, F-004, F-016-F-017, F-021, F-022, F-030, F-033, F-035, F-037, F-041, F-045

### Separate session

F-042 — React re-render profiling needs DevTools

---

## Next-Action Recommendations

### Done (2026-07-12)

- [x] Fix 36 lint warnings (F-025)
- [x] Add Prettier (F-026)
- [x] Resolve archives contradiction (F-020)
- [x] Reconcile all documentation (F-043, F-044, testing.md, README.md, CLAUDE.md, dev-workflow.md, frontend.md — all former .clinerules/ content now in CLAUDE.md)
- [x] Disambiguation resolution — 46 items: dead archive/compression (F-018, F-006, F-009, F-020b), PascalCase renames (F-023), compression disambiguation (F-020c), data/ → defaults/ (F-008), corrupted-tools/ consolidation (F-003), 12 file renames, tab/route renames
- [x] Documentation reconciliation (post-disambiguation) — evaluation-roadmap.md + next-session.md updated

### Done (2026-07-13)

1. [x] Pipeline-runner smoke test — promoted to `tests/services/pipeline-smoke.test.ts` (4 tests)
2. [x] Logging & Observability — wired `publishJobCreated`, replaced `console.error` with structured `createLogger`
3. [x] Validation hook bug fix — `validationHook` success-check + Standard Schema `Issue` handling
4. [x] E2E critical path test loop — 7 Playwright tests + browser smoke test
5. [x] Split StoryView.tsx + add useReducer (F-038) — Phase 2: StoryLog, StoryFooter, StoryViewHelpers extracted
6. [x] Split api.ts by resource (F-039) — Phase 3: 13 resource modules + client.ts + types.ts
7. [x] State infrastructure — Phase 4: TanStack Query + Zustand
8. [x] Create web/src/ subdirectories (F-040) — Phase 5: views/, components/, hooks/, lib/
9. [x] Package replacements — Phase 6: Sonner (toast) + Virtuoso (scroll)
10. [x] CSS convention cleanup — Phase 7: semantic color vars, font-size custom property
11. [x] Add Zod validation to routes (F-034) — @hono/standard-validator on 5 route files

### Done (2026-07-12 follow-up)

1. [x] Fix 12 frontend lint warnings — remainder from F-025
2. [x] Delete bun.lock (F-004)
3. [x] Apply npm patch updates (F-022)
4. [x] Create src/lib/ for remaining root utilities (F-007) — uuid.ts, crypto.ts, time.ts moved

### Do next (backend work)

- Split pipeline-runner.ts (F-031)
- Extract story-orchestrator.ts (F-028)
- Fix store bypasses (F-029)
- Add provider adapter (F-032)
- Group services/ into subdirectories (F-005)
