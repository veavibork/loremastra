# Next Session: Logging, Testing, Formatting — Before Refactors

## Context

A top-down evaluation of the Lorepalace codebase was completed (2026-07-12). 48 findings in `docs/evaluation-roadmap.md`, severity-ranked. 18 Should-fix items, 5 ready this week, 6 high-impact refactors for this month.

**The plan:** don't jump straight to the refactors. First, build the safety net.

## Phase 1: Logging & Observability (pre-refactor safety net)

Before touching the 1,464-line pipeline-runner or the 1,209-line StoryView, we need visibility into what's happening at runtime.

### Check for existing tools / OMP plugins FIRST

- **OpenLit / OpenTelemetry** — check if there's an OMP plugin or MCP tool for OpenLit (openlit.io). It provides OpenTelemetry-native tracing for LLM apps. If available, this could replace or supplement the hand-rolled `outbound-log.ts` and `job-events.ts` pub/sub system.
- **OMP monitoring plugins** — search `search_tool_bm25` for "logging," "tracing," "observability," "openlit," "opentelemetry" before building anything.
- **MCP servers** — check if an observability MCP server exists that could provide structured logging without code changes.

### What to build (only if no existing tool fits)

1. **Structured request/response logging** — every inference call (Featherless + Horde) logs: model, provider, input tokens, output tokens, latency, success/failure, retry count. Currently `outbound-log.ts` exists but may be incomplete.
2. **Job lifecycle events** — job created → claimed → running → done/failed/cancelled, with timestamps. The `job-events.ts` SSE pub/sub system exists; verify it covers all job types and transitions.
3. **Error telemetry** — catch and log all unhandled errors with stack traces, request context, and job state. Currently errors are swallowed in some catch blocks (`// ignore` in `recordOutcome`).
4. **Pipeline health metrics** — queue depth, worker lane utilization, slot contention, Horde poll success rate.

## Phase 2: Testing (pre-refactor safety net)

Per `evaluation-roadmap.md` Resolved/Deferred section: no test framework exists. Before refactoring, add one.

### Check for existing tools FIRST

- **Vitest** — the likely choice (Vite-native, fast, TypeScript-first). Check if OMP has a Vitest integration.
- **Playwright** — for E2E tests of critical user journeys (login → create story → setup → kickoff → post → retry).
- **OMP test plugins** — search for "testing," "vitest," "playwright," "coverage" before building.

### Minimum viable test coverage

1. **Store-level tests** — each `*-store.ts` gets basic CRUD tests. These are pure functions (db handle in, typed rows out) — the easiest and highest-value tests.
2. **Service-level tests** — `story-to-date.ts`, `archive.ts`, `memory-manifest.ts`. These compose store calls — test with an in-memory SQLite DB.
3. **Pipeline-runner smoke test** — one end-to-end job flow: enqueue → claim → execute → finish. The existing `scripts/test-memory-pipeline-smoke.ts` is a starting point; promote to a proper test.
4. **API contract tests** — verify each route returns the expected shape on success and error.

### Target

- `npm test` runs the full suite
- Coverage target: stores 80%+, services 60%+, routes 40%+

## Phase 3: Formatting & Linting (clean baseline)

1. **Fix the 36 oxlint warnings** (F-025) — mostly unused imports from refactors.
2. **Add Prettier or biome** (F-026) — run once across the codebase, add pre-commit hook.
3. **Rename 4 frontend components** to PascalCase (F-023).

## Phase 4: Refactors (informed by logging + tests)

Once logging and tests are in place, tackle the Should-fix items in priority order (see `docs/evaluation-roadmap.md` severity ranking):

1. pipeline-runner.ts split (F-031)
2. StoryView.tsx decomposition + useReducer (F-038)
3. stories.ts orchestrator extraction (F-028)
4. Archives contradiction resolution (F-020)
5. Compression naming disambiguation (F-020c)
6. Provider adapter (F-032)
7. Services/ subdirectories (F-005)
8. api.ts split by resource (F-039)

## Replacements to Consider

| Hand-rolled                         | Proven alternative           | Why                                                     |
| ----------------------------------- | ---------------------------- | ------------------------------------------------------- |
| `outbound-log.ts` + `job-events.ts` | OpenLit / OpenTelemetry      | Structured tracing, dashboards, no custom pub/sub       |
| `featherless.ts` streaming pipeline | Vercel AI SDK or similar     | Streaming, retry, fallback, tool calls — solved problem |
| `api-coordinator.ts` 409 handling   | TanStack Query or SWR        | Stale-while-revalidate, conflict resolution built-in    |
| Manual Zod-less route validation    | Hono `zValidator` middleware | Already in the Hono ecosystem, zero new deps            |
| `toast.ts` hand-rolled              | Sonner or react-hot-toast    | Accessibility, animations, stacking — solved            |
| `useStoryLogScroll.ts`              | Virtuoso or react-window     | Virtualized scrolling for long chat logs                |

**Rule:** before building infrastructure, check if OMP or the npm ecosystem already has it. This project's strength is its purpose-built domain logic (story-to-date, worldbook, memory pipeline) — not its plumbing.
