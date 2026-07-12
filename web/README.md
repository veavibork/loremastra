# Loremaster — Frontend

React 19 + Vite 8 single-page application for the Loremaster roleplaying platform. Connects
to the Hono backend via Vite's dev proxy (`/api` → `http://localhost:4113`).

## Quick start

From this directory:

```
npm install
npm run dev        # Vite dev server; backend must also be running (npm run dev from repo root)
npm run build      # type-check + production build
npm run lint       # oxlint
```

## Key views

| View             | File                | Purpose                                               |
| ---------------- | ------------------- | ----------------------------------------------------- |
| Story            | `StoryView.tsx`     | Chat, post controls, IC/OOC toggle, streaming replies |
| Lore > Worldbook | `WorldbookView.tsx` | CONTENT/ROSTER/MEMORY entry management                |
| Lore > Memory    | `MemoryView.tsx`    | Assembled prompt inspector                            |
| Story > Archives | `ArchivesView.tsx`  | Story-to-date segment management                      |
| Story > Saves    | `SavesView.tsx`     | Story/fork management                                 |
| Story > Logs     | `LogsView.tsx`      | Per-post generation telemetry                         |
| Story > Summary  | `SummaryView.tsx`   | Legacy gen_extract view (compression retired)         |
| Config > Agents  | `AgentsView.tsx`    | Model/param selection and fallback chains             |
| Config > Prompts | `PromptsView.tsx`   | Prompt template editor (stub)                         |
| Debug > Queue    | `QueueView.tsx`     | Live job queue and concurrency slots                  |
| Settings         | `SettingsView.tsx`  | Layout JSON, banned words, CSS, play-tab prefs        |

## Conventions

- One `.css` file per view/component — no CSS framework
- No state management library — React state + `apiFetch` (`api.ts`)
- `api-coordinator.ts` bounds polling frequency
- Touch-first; must work on Android and Windows browsers
- Config-driven layout via `Nav.tsx` + `registry.tsx`
- Build-info header (`__BUILD_INFO__`) stamped at `vite build` time for deploy verification
