# Next Session: Cleanup → Refactors

## Context

A top-down evaluation of the Lorepalace codebase was completed (2026-07-12). 48 findings in `docs/evaluation-roadmap.md`, severity-ranked. 18 Should-fix items. Documentation reconciliation and formatting workflow completed 2026-07-12.

**The plan:** finish remaining cleanup items, then proceed to the high-impact refactors.

## Completed (2026-07-12)

- [x] Fix 36 backend oxlint warnings (F-025) — 0 warnings remaining
- [x] Add Prettier formatting workflow (F-026) — `.prettierrc`, `lint-staged` pre-commit hook, `npm run format` in both packages
- [x] Resolve archives contradiction (F-020) — loremaster.md updated; archives confirmed active
- [x] Reconcile all documentation (F-043, F-044) — 9 docs updated: loremaster.md, stack.md, frontend.md, testing.md, README.md, CLAUDE.md, dev-workflow.md, cline-setup.md, development.md
- [x] Testing framework confirmed — Vitest (`npm test`) + Playwright (`npm run test:e2e`) already configured; stack.md and testing.md updated

## Phase 1: Remaining Cleanup

The small items that block nothing but are worth doing before the big refactors.

1. **Fix 12 frontend oxlint warnings** — 4 `only-export-components`, 5 `exhaustive-deps`, 3 from reasoningDisplay/playTabSettings. See `cd web && npm run lint`.
2. **Delete dead code:**
   - `archive-worker.ts` (F-018) — zero imports, confirmed dead
   - `src/experiments/` directory + stub (F-009) — 122-byte stub
   - `bun.lock` (F-004) — Bun experiment, npm is the declared package manager
3. **F-023 PascalCase renames** — `playTabSettings.tsx` → `PlayTabSettings.tsx`, etc. User deferred; revisit when ready.
4. **F-020c Compression naming** — disambiguate "compression" into `per-post-extract` (retired), `story-to-date-recap` (active), `story-to-date-fold` (active).

## Phase 2: Expand Test Coverage

Vitest and Playwright are configured but coverage is low. Before refactoring, add tests for the critical paths.

1. **Store-level tests** — each `*-store.ts` gets basic CRUD tests. Pure functions (db handle in, typed rows out) — highest-value, easiest tests.
2. **Service-level tests** — `story-to-date.ts`, `archive.ts`, `memory-manifest.ts`. Compose store calls — test with in-memory SQLite.
3. **Pipeline-runner smoke test** — promote `scripts/test-memory-pipeline-smoke.ts` to a proper vitest test.
4. **API contract tests** — verify each route returns expected shape on success and error.
5. **E2E tests** — critical user journeys: login → create story → setup → kickoff → post → retry.

Target: stores 80%+, services 60%+, routes 40%.

## Phase 3: Logging & Observability (pre-refactor safety net)

Before touching the 1,464-line pipeline-runner or the 1,209-line StoryView, add visibility into runtime behavior.

### Check for existing tools FIRST

- **OpenLit / OpenTelemetry** — check if there's an OMP plugin or MCP tool for OpenLit.
- **OMP monitoring plugins** — search `search_tool_bm25` for "logging," "tracing," "observability."
- **MCP servers** — check if an observability MCP server exists.

### What to build (only if no existing tool fits)

1. **Structured request/response logging** — model, provider, tokens, latency, success/failure, retry count.
2. **Job lifecycle events** — job created → claimed → running → done/failed/cancelled with timestamps.
3. **Error telemetry** — catch unhandled errors with stack traces, request context, job state.
4. **Pipeline health metrics** — queue depth, worker lane utilization, slot contention, Horde poll success rate.

## Phase 4: Refactors (informed by logging + tests)

Priority order (matching `docs/evaluation-roadmap.md` severity ranking):

1. pipeline-runner.ts split (F-031)
2. StoryView.tsx decomposition + useReducer (F-038)
3. stories.ts orchestrator extraction (F-028)
4. Provider adapter (F-032)
5. Services/ subdirectories (F-005)
6. api.ts split by resource (F-039)

## Replacements to Consider

| Hand-rolled | Proven alternative | Why |
|---|---|---|---|
| `outbound-log.ts` + `job-events.ts` | OpenLit / OpenTelemetry | Structured tracing, dashboards, no custom pub/sub |
| `featherless.ts` streaming pipeline | Vercel AI SDK or similar | Streaming, retry, fallback, tool calls — solved problem |
| `api-coordinator.ts` 409 handling | TanStack Query or SWR | Stale-while-revalidate, conflict resolution built-in |
| Manual Zod-less route validation | Hono `zValidator` middleware | Already in the Hono ecosystem, zero new deps |
| `toast.ts` hand-rolled | Sonner or react-hot-toast | Accessibility, animations, stacking — solved |
| `useStoryLogScroll.ts` | Virtuoso or react-window | Virtualized scrolling for long chat logs |

**Rule:** before building infrastructure, check if OMP or the npm ecosystem already has it. This project's strength is its purpose-built domain logic (story-to-date, worldbook, memory pipeline) — not its plumbing.
