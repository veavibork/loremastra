# Next Session

## Current Status (2026-07-13)

Frontend refactor (Phases 1–7) complete. 142 tests total (126 Vitest + 16 Playwright). 0 compilation errors. 0 lint warnings. Bundle: 143KB gzipped JS.

**What's done (frontend refactor, all sessions):**

- **Phase 1: Cleanup** — Dead archive code deleted from api.ts, CSS files renamed (ArchivesView→SegmentsView, MemoryView→ContextView), `storage-keys.ts` created, `bun.lock` deleted, `AutoGrowTextarea` extracted from StoryView.
- **Phase 2: StoryView Decomposition** — `useReducer` for 13 interdependent useState calls, `StoryLog.tsx` + `StoryFooter.tsx` + `StoryViewHelpers.ts` extracted, `forceTick` timer replaced with `useRef` + direct DOM update, inline onClick handlers wrapped in `useCallback`.
- **Phase 3: api.ts Split** — 13 resource modules + `client.ts` + `types.ts` + `index.ts` barrel in `web/src/api/`.
- **Phase 4: State Infrastructure** — TanStack Query + Zustand installed. `QueryClientProvider` in App.tsx. Zustand store with `persist` middleware (single `loremaster.ui` key, migration from old keys). 12 TanStack Query hook files. 9 views migrated to `useQuery`. Polling via `refetchInterval`. `storage-keys.ts` deleted.
- **Phase 5: Subdirectories** — `views/`, `components/`, `hooks/`, `lib/` created. 15 view files, 10 components, 2 hooks, 9 utilities moved. ~60 import paths updated. Fixed `ButtonContainerRow` regression and `SegmentsView` anti-pattern.
- **Phase 6: Package Replacements** — Sonner replaces hand-rolled toast (+9KB). Virtuoso replaces `useStoryLogScroll` (+19KB). E2E: 7/7 critical-path tests pass.
- **Phase 7: CSS Convention Cleanup** — `font-size: 15px` → `var(--entry-font-size)` in 6 files. 9 semantic color custom properties added, 28 hardcoded hex colors replaced across 10 files. Remaining px values audited (all functional constraints).

**What's done (prior sessions, pre-refactor):**

- Validation hook bug fix: `validationHook` success-check + Standard Schema `Issue` handling
- npm patch updates (hono, tsx, @types/node, oxlint, vite)
- E2E critical path test loop (7 tests) + browser smoke test
- Pipeline-runner smoke test promoted to `tests/services/`
- Logging & observability: `publishJobCreated` wired, `console.error` → `createLogger`
- Zod route validation on 5 route files + shared `validationHook`
- Store tests (41 new), service tests (9 new), API contract tests (9 new)
- 36 backend + 12 frontend oxlint warnings fixed, Prettier configured
- Archives fully retired, disambiguation resolution (46 items)

## Remaining (by priority)

### 1. Backend work

User indicated backend work is the next focus area. Specific items TBD.

### 2. Deferred frontend items

- **Settings editor UX** — Schema-driven forms for global CSS, play tab, banned phrases. Validated JSON textarea for layout config and toggle presets. `json-edit-react` already removed. Layout/toggle preset handling deferred until forms are in place.
- **Context budget visualization** — Token usage breakdown shown to user (gap vs SillyTavern).
- **Per-response metadata** — Model, timing, token count per response (gap vs KoboldAI / SillyTavern).

### 3. Known limitations

- `withModelFallback` only swaps `.model` between candidates — fallback row's own temperature/limits/sampler params are stored but not used at runtime. Primary row's params apply to all candidates.
- `gen_metrics` not populated for background memory/naming jobs — queue-wide telemetry incomplete.
- `preference_profiles` table exists but unused — no preference-profile CRUD yet.
- Featherless server-side request cancellation unsupported — aborting client fetch may not free their concurrency slot.
