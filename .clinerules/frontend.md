# Frontend Patterns

The frontend lives in `web/` as a separate npm package (React 19 + Vite 8 + TypeScript).
It is strict-adjacent: `noUnusedLocals`, `noUnusedParameters`,
`noFallthroughCasesInSwitch`, bundler module resolution, `noEmit`.

## Architecture

- **Entry:** `main.tsx` → `App.tsx` (root component)
- **Views:** Top-level screens are `*View.tsx` files — `StoryView`, `PreferencesView`,
  `LogsView`, `ContextView`, `WorldbookView`, `SegmentsView`, `SavesView`, `AgentsView`,
  `PromptsView`, `QueueView`.
- **CSS pairing:** Each view has a matching `.css` file (e.g. `StoryView.css`).
  Component-level CSS files follow the same pattern.
- **API layer:** `api.ts` (core fetch wrapper), `api-limiter.ts` (request orchestration).
- **Utilities:** `format-time.ts`, `layoutUtils.ts`, `global-css-settings.ts`,
  `panel-types.ts`, `prompt-block.ts`, `toast.ts`, `error-capture.ts`.
- **Hooks:** `useStoryLogScroll.ts`, `useVisualViewport.ts` (custom hooks prefixed `use`).

## Conventions

- **Component naming:** PascalCase for components (`StoryView`, `Nav`, `ClaimGate`).
  Hooks are camelCase with `use` prefix. Utility modules are kebab-case where possible.
- **No CSS framework** — plain CSS files per component/view. Layout is config-driven
  (see `loremaster.md` UI Structure): component sizing uses relative/proportional units,
  not fixed pixel values.
- **No state management library** — React state + fetch. The app uses a claim/reclaim
  session model; see `ClaimGate.tsx`.
- **`json-edit-react`** is the only notable third-party dependency — used for settings
  tree editing (`SettingsTreeEditor.tsx`).

## Linting

- **oxlint** is the configured linter (`web/.oxlintrc.json`).
  - Plugins: `react`, `typescript`, `oxc`
  - Key rules: `react/rules-of-hooks: error`, `react/only-export-components: warn`
- Run with `npm run lint` from `web/`.
- **Prettier** is configured for formatting (`.prettierrc`, `.prettierignore`). Run with `npm run format` from `web/`. A `lint-staged` pre-commit hook auto-formats staged files on commit.

## Build

- `npm run build` (from `web/`) runs `tsc -b && vite build`.
- `npm run preview` serves the production build locally.
- The Vite dev server proxies `/api` to `http://localhost:4113` — the backend must be
  running for the frontend to function in dev.

## When editing frontend code

- Check `.oxlintrc.json` rules before adding patterns that might violate hooks rules.
- Prefer extending existing views/components over creating new top-level files.
- CSS changes should respect the config-driven layout philosophy — avoid hardcoded pixel
  dimensions; use percentages, flex, and grid.
- The frontend must remain viable on Android and Windows browsers without native app
  installation — design touch-first.
