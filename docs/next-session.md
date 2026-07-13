# Next Session: Refactors

## Current Status (2026-07-13)

Disambiguation, cleanup, lint, Zod validation, test expansion, and observability are complete. 136 tests total (126 Vitest + 10 Playwright contract). 0 compilation errors. 0 lint warnings.

**What's done this session:**

- Pipeline-runner smoke test: promoted `scripts/test-memory-pipeline-smoke.ts` to `tests/services/pipeline-smoke.test.ts` (4 tests)
- Logging & Observability: wired `publishJobCreated` in all createJob call sites (stories, pipeline-runner, story-to-date, worldbook-compact); replaced all `console.error` calls in pipeline-runner with structured `createLogger` logging

**What's already done (prior sessions):**

- Delete `bun.lock` (F-004), apply npm patch updates (F-022), move `uuid.ts`/`crypto.ts` to `src/lib/` (F-007)
- Fix 12 frontend oxlint warnings → 0
- Zod route validation: `@hono/standard-validator` on 5 route files + shared `validationHook`
- Store tests: `worldbook-store` + `story-to-date-store` CRUD (41 new tests)
- Service tests: `context-manifest` + `context-invalidation` smoke (9 new tests)
- API contract tests: 10 Playwright route-level tests (`e2e/smoke.spec.ts`)
- 36 backend oxlint warnings fixed (F-025), Prettier (F-026)
- Archives fully retired (F-020)
- Documentation reconciled (F-043, F-044)
- Disambiguation resolution — 46 items across 6 phases

## Remaining (by priority)

### 1. Refactors

Priority order (matching severity ranking):

1. `pipeline-runner.ts` split (F-031)
2. `StoryView.tsx` decomposition + `useReducer` (F-038)
3. `stories.ts` orchestrator extraction (F-028)
4. Provider adapter (F-032)
5. `services/` subdirectories (F-005)
6. `api.ts` split by resource (F-039)

### 2. E2E critical path

`login → create → setup → story transition → post → retry` — needs seeded DB + full browser `page` fixture. Dedicated session.

### 3. Remaining cleanup from evaluation

- Apply npm patch updates (F-022) — minor version debt

## Replacements to Consider

| Hand-rolled                               | Proven alternative        | Why                                                     |
| ----------------------------------------- | ------------------------- | ------------------------------------------------------- |
| `outbound-telemetry.ts` + `job-events.ts` | OpenLit / OpenTelemetry   | Structured tracing, dashboards, no custom pub/sub       |
| `featherless.ts` streaming pipeline       | Vercel AI SDK or similar  | Streaming, retry, fallback, tool calls — solved problem |
| `api-limiter.ts` 409 handling             | TanStack Query or SWR     | Stale-while-revalidate, conflict resolution built-in    |
| `toast.ts` hand-rolled                    | Sonner or react-hot-toast | Accessibility, animations, stacking — solved            |
| `useStoryLogScroll.ts`                    | Virtuoso or react-window  | Virtualized scrolling for long chat logs                |

**Rule:** before building infrastructure, check if OMP or the npm ecosystem already has it. This project's strength is its purpose-built domain logic (story-to-date, worldbook, context pipeline) — not its plumbing.
