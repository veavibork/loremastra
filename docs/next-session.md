# Next Session: Refactors

## Current Status (2026-07-13)

Disambiguation, cleanup, lint, Zod validation, test expansion, and observability are complete. 142 tests total (126 Vitest + 16 Playwright). 0 compilation errors. 0 lint warnings.

**What's done this session:**

- Validation hook bug fix: `validationHook` was called on both success and failure by `@hono/standard-validator` but never checked `result.success` — all Zod-validated routes were silently broken. Fixed by adding success early-return and properly handling Standard Schema `Issue` types (no `any`).
- npm patch updates applied: hono 4.12.30, tsx 4.23.1, @types/node 24.13.3, oxlint 1.73.0, vite 8.1.4. All tests pass.
- E2E critical path test loop: `e2e/critical-path.spec.ts` exercises `login → create → setup → kickoff → post → retry` via Playwright `request` fixture (7 tests), plus browser smoke test verifying ClaimGate login + StoryView render. Total E2E: 16 tests (9 contract + 7 critical path). Playwright config updated with frontend webServer and globalSetup for test user seeding.
- Pipeline-runner smoke test: promoted `scripts/test-memory-pipeline-smoke.ts` to `tests/services/pipeline-smoke.test.ts` (4 tests)
- Logging & Observability: wired `publishJobCreated` in all createJob call sites (stories, pipeline-runner, story-to-date, worldbook-compact); replaced all `console.error` calls in pipeline-runner with structured `createLogger` logging

**What's already done (prior sessions):**

- Delete `bun.lock` (F-004), move `uuid.ts`/`crypto.ts` to `src/lib/` (F-007)
- Fix 12 frontend oxlint warnings → 0
- Zod route validation: `@hono/standard-validator` on 5 route files + shared `validationHook`
- Store tests: `worldbook-store` + `story-to-date-store` CRUD (41 new tests)
- Service tests: `context-manifest` + `context-invalidation` smoke (9 new tests)
- API contract tests: Playwright route-level tests (`e2e/smoke.spec.ts` — 9 tests)
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

## Replacements to Consider

| Hand-rolled                               | Proven alternative        | Why                                                     |
| ----------------------------------------- | ------------------------- | ------------------------------------------------------- |
| `outbound-telemetry.ts` + `job-events.ts` | OpenLit / OpenTelemetry   | Structured tracing, dashboards, no custom pub/sub       |
| `featherless.ts` streaming pipeline       | Vercel AI SDK or similar  | Streaming, retry, fallback, tool calls — solved problem |
| `api-limiter.ts` 409 handling             | TanStack Query or SWR     | Stale-while-revalidate, conflict resolution built-in    |
| `toast.ts` hand-rolled                    | Sonner or react-hot-toast | Accessibility, animations, stacking — solved            |
| `useStoryLogScroll.ts`                    | Virtuoso or react-window  | Virtualized scrolling for long chat logs                |

**Rule:** before building infrastructure, check if OMP or the npm ecosystem already has it. This project's strength is its purpose-built domain logic (story-to-date, worldbook, context pipeline) — not its plumbing.
