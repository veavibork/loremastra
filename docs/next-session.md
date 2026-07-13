# Next Session: Observability → Refactors

## Current Status (2026-07-12)

The disambiguation resolution, cleanup, lint, Zod validation, and test expansion are all complete. 132 tests total (122 Vitest + 10 Playwright contract). 0 compilation errors. 0 backend lint warnings. 0 frontend lint warnings.

**What's done this session:**

- Delete `bun.lock` (F-004), apply npm patch updates (F-022), move `uuid.ts`/`crypto.ts` to `src/lib/` (F-007)
- Fix 12 frontend oxlint warnings → 0
- Zod route validation: `@hono/standard-validator` on 5 route files + shared `validationHook`
- Store tests: `worldbook-store` + `story-to-date-store` CRUD (41 new tests)
- Service tests: `context-manifest` + `context-invalidation` smoke (9 new tests)
- API contract tests: 10 Playwright route-level tests (`e2e/smoke.spec.ts`)

**What's already done (prior session):**

- 36 backend oxlint warnings fixed (F-025), Prettier (F-026)
- Archives fully retired (F-020)
- Documentation reconciled (F-043, F-044)
- Disambiguation resolution — 46 items across 6 phases

## Remaining (by priority)

### 1. Pipeline-runner smoke test (30 min)

Promote `scripts/test-memory-pipeline-smoke.ts` to a proper vitest test in `tests/services/`. Already imported from `src/`, just needs `describe`/`it` wrappers.

### 2. Logging & Observability (pre-refactor safety net)

Before touching the large files (pipeline-runner, StoryView, api.ts), add visibility:

- **Structured request/response logging** — model, provider, tokens, latency, success/failure, retry count
- **Job lifecycle events** — job created → claimed → running → done/failed/cancelled with timestamps
- **Error telemetry** — catch unhandled errors with stack traces, request context, job state
- **Pipeline health metrics** — queue depth, worker lane utilization, slot contention

Check OMP/MCP/npm for existing solutions before building.

### 3. Refactors

Priority order (matching severity ranking):

1. `pipeline-runner.ts` split (F-031)
2. `StoryView.tsx` decomposition + `useReducer` (F-038)
3. `stories.ts` orchestrator extraction (F-028)
4. Provider adapter (F-032)
5. `services/` subdirectories (F-005)
6. `api.ts` split by resource (F-039)

### 4. E2E critical path

`login → create → setup → story transition → post → retry` — needs seeded DB + full browser `page` fixture. Dedicated session.

## Replacements to Consider

| Hand-rolled                               | Proven alternative        | Why                                                     |
| ----------------------------------------- | ------------------------- | ------------------------------------------------------- |
| `outbound-telemetry.ts` + `job-events.ts` | OpenLit / OpenTelemetry   | Structured tracing, dashboards, no custom pub/sub       |
| `featherless.ts` streaming pipeline       | Vercel AI SDK or similar  | Streaming, retry, fallback, tool calls — solved problem |
| `api-limiter.ts` 409 handling             | TanStack Query or SWR     | Stale-while-revalidate, conflict resolution built-in    |
| `toast.ts` hand-rolled                    | Sonner or react-hot-toast | Accessibility, animations, stacking — solved            |
| `useStoryLogScroll.ts`                    | Virtuoso or react-window  | Virtualized scrolling for long chat logs                |

**Rule:** before building infrastructure, check if OMP or the npm ecosystem already has it. This project's strength is its purpose-built domain logic (story-to-date, worldbook, context pipeline) — not its plumbing.
