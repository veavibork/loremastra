# Next Session: Cleanup → Refactors

## Post-Disambiguation Status (2026-07-12)

The full disambiguation resolution plan (`docs/disambiguation-resolution.md`) is complete: 46 items across 6 phases — dead code purge, backend file renames (12 files), content changes (column/route/job-type renames), file moves, frontend PascalCase renames, and verification. 72/72 tests passing. 0 compilation errors. 0 backend lint warnings. 12 pre-existing frontend lint warnings.

13 evaluation findings resolved by this work: F-018 (archive-worker.ts), F-006 (compression workers), F-009 (experiments/), F-020b (gen_extract column), F-020c (compression disambiguation), F-023 (PascalCase renames), F-008 (data/ → defaults/), F-003 (corrupted-tools/ consolidation), F-024 (compress naming), F-027 (6 semantic renames), plus updates to F-020 (fully retired) and F-007 (time.ts moved to lib/).

## Completed (2026-07-12)

- [x] Fix 36 backend oxlint warnings (F-025) — 0 warnings remaining
- [x] Add Prettier formatting workflow (F-026)
- [x] Resolve archives contradiction (F-020) — fully retired: archive tables/workers/purge deleted
- [x] Reconcile all documentation (F-043, F-044) — 9 docs updated twice (initial reconciliation + post-disambiguation pass)
- [x] Testing framework confirmed — Vitest 72/72 + Playwright configured
- [x] Disambiguation resolution — 46 items: dead code, renames, file moves, frontend PascalCase
- [x] Documentation reconciliation (post-disambiguation) — evaluation-roadmap.md + next-session.md updated

## Phase 1: Remaining Cleanup (trivial)

Everything that was quick cleanup is done. What's left:

1. **Fix 12 frontend oxlint warnings** — 4 `only-export-components`, 5 `exhaustive-deps`, 3 remaining. `cd web && npm run lint`.
2. **Delete bun.lock** (F-004) — npm is the declared package manager; bun.lock is a stale artifact.
3. **Apply npm patch updates** (F-022) — zero vulnerabilities, minor patch debt. Align TypeScript versions.
4. **Move remaining utils to src/lib/** (F-007) — time.ts is done; uuid.ts and crypto.ts still at root.

## Phase 2: Expand Test Coverage

Vitest and Playwright are configured but coverage is low. Before refactoring, add tests:

1. **Store-level tests** — each `*-store.ts` gets basic CRUD tests. Pure functions (db handle in, typed rows out) — highest-value, easiest tests.
2. **Service-level tests** — `story-to-date.ts`, `context-manifest.ts`, `context-invalidation.ts`. Compose store calls — test with in-memory SQLite.
3. **Pipeline-runner smoke test** — promote `scripts/test-memory-pipeline-smoke.ts` to a proper vitest test.
4. **API contract tests** — verify each route returns expected shape on success and error.
5. **E2E tests** — critical user journeys: login → create story → setup → story transition → post → retry.

Target: stores 80%+, services 60%+, routes 40%.

## Phase 3: Logging & Observability (pre-refactor safety net)

Before touching the large files (pipeline-runner, StoryView, api.ts), add visibility:

### Check for existing tools FIRST

- **OpenLit / OpenTelemetry** — check if there's an OMP plugin or MCP tool.
- **OMP monitoring plugins** — search `search_tool_bm25` for "logging", "tracing", "observability".
- **MCP servers** — check if an observability MCP server exists.

### What to build (only if no existing tool fits)

1. **Structured request/response logging** — model, provider, tokens, latency, success/failure, retry count.
2. **Job lifecycle events** — job created → claimed → running → done/failed/cancelled with timestamps.
3. **Error telemetry** — catch unhandled errors with stack traces, request context, job state.
4. **Pipeline health metrics** — queue depth, worker lane utilization, slot contention, Horde poll success rate.

## Phase 4: Refactors (informed by logging + tests)

Priority order (matching severity ranking):

1. **pipeline-runner.ts split** (F-031) — god object; split orchestration, dispatch, retry/recovery
2. **StoryView.tsx decomposition** (F-038) — extract sub-components + useReducer
3. **stories.ts orchestrator extraction** (F-028) — thin routes, thick services
4. **Provider adapter** (F-032) — a third provider should be a config entry + new adapter
5. **Services/ subdirectories** (F-005) — 26 flat files; group by domain
6. **api.ts split by resource** (F-039) — 1,024-line monolith → `api/stories.ts`, `api/agents.ts`, etc.

## Replacements to Consider

| Hand-rolled                               | Proven alternative           | Why                                                     |
| ----------------------------------------- | ---------------------------- | ------------------------------------------------------- |
| `outbound-telemetry.ts` + `job-events.ts` | OpenLit / OpenTelemetry      | Structured tracing, dashboards, no custom pub/sub       |
| `featherless.ts` streaming pipeline       | Vercel AI SDK or similar     | Streaming, retry, fallback, tool calls — solved problem |
| `api-limiter.ts` 409 handling             | TanStack Query or SWR        | Stale-while-revalidate, conflict resolution built-in    |
| Manual Zod-less route validation          | Hono `zValidator` middleware | Already in the Hono ecosystem, zero new deps            |
| `toast.ts` hand-rolled                    | Sonner or react-hot-toast    | Accessibility, animations, stacking — solved            |
| `useStoryLogScroll.ts`                    | Virtuoso or react-window     | Virtualized scrolling for long chat logs                |

**Rule:** before building infrastructure, check if OMP or the npm ecosystem already has it. This project's strength is its purpose-built domain logic (story-to-date, worldbook, context pipeline) — not its plumbing.
