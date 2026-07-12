# Testing Conventions

## Test runners

**Unit / integration:** Vitest, configured in `vitest.config.ts`. Tests in `tests/db/` (store tests)
and `tests/lib/` (pure-logic tests).

- `npm test` — single run
- `npm run test:watch` — watch mode
- `npm run test:coverage` — with coverage

**E2E:** Playwright, configured in `playwright.config.ts`. Tests in `e2e/`.

- `npm run test:e2e`

## Smoke / diagnostic scripts

Standalone TypeScript scripts in `scripts/`, run individually with `tsx`:

| Prefix                | Purpose                                                         |
| --------------------- | --------------------------------------------------------------- |
| `test-`               | Smoke/integration checks — verify a subsystem works end-to-end  |
| `probe-`              | Diagnostic experiments — explore an API/provider behavior       |
| `debug-`              | Debugging tools — inspect specific state or trace a bug         |
| `inspect-` / `check-` | Read-only inspection of DB or runtime state                     |
| `story-to-date-*`     | Memory pipeline experiments and diagnostics                     |
| `vm-*`                | VM-sync diagnostics (`.cjs`/`.mjs` variants for standalone use) |

## Key test scripts

- `test-memory-pipeline-smoke.ts` — in-process integration test: memory pipeline, HTTP API
  checks, and unit smokes. The closest thing to a "run the test suite" command.
- `test-content-store.ts` — content store CRUD smoke.
- `test-memory-invalidation.ts` — memory stamp invalidation on edit/retry/undo.
- `test-memory-pipeline-http.ts` — memory pipeline via HTTP endpoints.
- `test-post-index-smoke.ts` — tag indexing after post changes.
- `test-role-suggestions.ts` — role suggestion logic.

## When to add a new script

- **New `test-` script** — when adding a feature that warrants a repeatable smoke check.
  Follow the pattern of existing test scripts: import from `src/`, run in-process, print
  pass/fail, exit with status code.
- **New `probe-`/`debug-` script** — when investigating a specific behavior. These are
  disposable; don't be afraid to write one, use it, and leave it for future reference.
- **New vitest test** — when adding a feature that warrants a repeatable unit/integration check.
  Add to `tests/db/` or `tests/lib/` following the existing patterns.

## Before running scripts that touch the DB

- Scripts that call `getStoryDb()` directly should pass `{ skipRecovery: true }` to avoid
  resetting in-flight jobs in the main server process (see `database.md`).
- Scripts that write to the DB outside the HTTP API should call
  `notify_direct_mutation` via the MCP server afterward (see `dev-workflow.md`).
- Consider setting `LOREMASTER_DATA_DIR` to a temp directory if the script might corrupt
  data — never run destructive scripts against your dev database.
