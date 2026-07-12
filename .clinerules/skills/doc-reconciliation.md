# Documentation Reconciliation

Run after every session that changed code, config, or tooling. Ensures docs match reality.

## Docs Inventory

| File                          | Role                                         |
| ----------------------------- | -------------------------------------------- |
| `loremaster.md`               | Project reference, architecture, terminology |
| `.clinerules/stack.md`        | Tech stack, commands, directory map          |
| `.clinerules/frontend.md`     | Frontend patterns, conventions               |
| `.clinerules/testing.md`      | Test framework, script conventions           |
| `.clinerules/database.md`     | DB patterns, schema evolution                |
| `.clinerules/dev-workflow.md` | Dev workflow, MCP tools, environment         |
| `README.md`                   | Setup, run commands, project layout          |
| `CLAUDE.md`                   | Session checklist, command reference         |
| `docs/development.md`         | Milestone history, implementation notes      |
| `docs/roadmap.md`             | Open backlog                                 |
| `docs/cline-setup.md`         | Editor setup recommendations                 |

## Quick Checklist

Run through each claim; verify against repo reality.

### Commands (`stack.md` + `README.md`)

- [ ] Every `package.json` script has a doc entry
- [ ] No documented commands reference deleted scripts

### Dependencies (`stack.md`)

- [ ] Listed deps match `package.json` (both root + web)
- [ ] No stale deps listed that were removed

### Directory map (`stack.md` + `loremaster.md`)

- [ ] Every documented directory exists (or marked planned)
- [ ] Every real source directory has a doc entry
- [ ] No dead directories listed as active

### Testing (`testing.md` + `stack.md`)

- [ ] Framework configs exist and `npm test` works
- [ ] Script prefixes table matches actual `scripts/` contents

### Lint / Format (`stack.md` + `frontend.md`)

- [ ] Linter config exists, `npm run lint` produces expected count
- [ ] Formatter config exists, pre-commit hook active
- [ ] No stale "no formatter" / "no linter" claims

### Architecture (`loremaster.md`)

- [ ] Provider descriptions match actual integrations
- [ ] Pipeline / memory model matches code
- [ ] "Retired" features aren't actively referenced; "active" features aren't described as retired
- [ ] Current State section lists accurate dev tooling

### Recent Changes (`development.md`)

- [ ] Current session's work has an entry

### Roadmap (`roadmap.md`)

- [ ] Completed items removed or struck through
- [ ] No items listed as pending that are done

## Standard Fixes

Fix the doc to match the code, unless:

- The code accidentally diverged from intended design
- The doc describes a deliberate future state not yet reached

For deliberate gaps: document as **deferred/planned**, not as "currently implemented."

## After Reconciliation

1. `npm run format` on changed docs
2. `git add` docs; commit as `docs: reconcile documentation`
3. Update `docs/evaluation-roadmap.md` if findings resolved
4. Update `docs/next-session.md` if remaining work changed
