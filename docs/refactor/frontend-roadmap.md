# Frontend Refactor Roadmap

Started 2026-07-13. Purpose: plan the frontend overhaul identified in `evaluation-roadmap.md` Phase 3 and `next-session.md`.

---

## 1. Current State: File Map

Everything lives flat in `web/src/` — no subdirectories (F-040). The clinerules `frontend.md` describes a convention where views, components, hooks, and utilities are separate categories, but they're not reflected in the directory structure.

```
web/src/
├── main.tsx              # Entry: installGlobalErrorCapture → render App
├── App.tsx               # Root: gate → layout → Nav
├── App.css
├── index.css             # CSS custom properties, root styles, hardcoded fallbacks
│
├── Views (top-level screens, each with matching .css)
│   ├── StoryView.tsx         51.0KB / 1335 lines  ← largest file in either package
│   ├── StoryView.css
│   ├── PreferencesView.tsx   10.3KB (wraps SettingsTreeEditor)
│   ├── SettingsTreeEditor.tsx 14.7KB (json-edit-react wrapper)
│   ├── SettingsTreeEditor.css
│   ├── WorldbookView.tsx     8.9KB
│   ├── WorldbookView.css
│   ├── SegmentsView.tsx      14.0KB  (story-to-date segment management)
│   ├── AgentsView.tsx        17.9KB
│   ├── AgentsView.css
│   ├── ContextView.tsx       3.4KB   (prompt preview / context manifest)
│   ├── SavesView.tsx         5.6KB
│   ├── SavesView.css
│   ├── LogsView.tsx          3.8KB
│   ├── LogsView.css
│   ├── QueueView.tsx         2.9KB
│   ├── PromptsView.tsx       2.9KB
│   ├── PromptsView.css
│   ├── ClaimGate.tsx         4.0KB   (session claim/reclaim screen)
│   ├── ClaimGate.css
│   ├── AccountSettings.tsx   4.5KB
│   ├── AccountSettings.css
│   ├── ApiKeysSection.tsx    3.6KB
│   ├── ApiKeysSection.css
│   ├── ToastHost.tsx         1.0KB
│   └── ToastHost.css
│
├── Reusable Components
│   ├── Nav.tsx               4.3KB   (tab bar + column layout + resize)
│   ├── Nav.css
│   ├── EntryContent.tsx      4.2KB   (React.memo post renderer, inline formatting + worldbook highlights)
│   ├── ButtonContainerRow.tsx 3.7KB  (config-driven button row from layout config)
│   ├── ButtonContainerRow.css
│   ├── ReasoningDisplay.tsx  3.0KB   (reasoning trace panel + localStorage prefs)
│   ├── StoryPanel.tsx        372B    (thin wrapper: StoryView)
│   ├── StoryToggles.tsx      6.1KB   (length/mood/param/model/effort cycling)
│   ├── PlayTabSettings.tsx   4.1KB   (context provider for display settings)
│   └── Registry.tsx          1.3KB   (tab-id → component lookup)
│
├── Hooks
│   ├── useStoryLogScroll.ts  4.6KB   (scroll pin-to-bottom, prepend-restore, edit protection)
│   └── useVisualViewport.ts  948B    (mobile keyboard viewport compensation)
│
├── API / Data Layer
│   ├── api.ts               32.7KB / ~1080 lines  (monolithic API client)
│   └── api-limiter.ts        1.9KB   (concurrency limiter + GET dedup, max 4 concurrent)
│
├── Utilities
│   ├── toast.ts              2.6KB   (hand-rolled toast: pub/sub, auto-dismiss, backend reporting)
│   ├── global-css-settings.ts 2.2KB  (CSS custom property injection from server config)
│   ├── layoutUtils.ts        1.8KB   (flattenNavTabs, DEFAULT_INPUT_BAR)
│   ├── format-time.ts        487B
│   ├── error-capture.ts      1.4KB   (global console.error → toast bridge)
│   ├── prompt-block.ts       1.1KB   (prompt message block classification)
│   ├── worldbookBlocks.ts    970B    (must stay in sync with src/services/worldbook-extraction.ts)
│   └── panel-types.ts        467B    (PanelProps interface)
│
├── Stale / Orphaned
│   ├── ArchivesView.css      3.5KB   ← component renamed to SegmentsView, still imports this CSS
│   └── MemoryView.css        702B    ← component renamed to ContextView, still imports this CSS
│
└── Config
    ├── vite-env.d.ts
    └── (package.json: react 19, react-dom 19, json-edit-react — 3 runtime deps total)
```

---

## 2. Component Separation Assessment

**Views (11):** `StoryView`, `PreferencesView`, `WorldbookView`, `SegmentsView`, `AgentsView`, `ContextView`, `SavesView`, `LogsView`, `QueueView`, `PromptsView`, `SettingsTreeEditor`

**Reusable components (8):** `Nav`, `EntryContent`, `ButtonContainerRow`, `ReasoningDisplay`, `ClaimGate`, `AccountSettings`, `ApiKeysSection`, `ToastHost`

**Hooks (2 true hooks + 4 context/hook pairs):** `useStoryLogScroll`, `useVisualViewport`, `useGlobalCssSettings`, `useReasoningDisplayPrefs`, `useStoryToggles`, `usePlayTabSettings`/`useSetPlayTabSettings`

### Issues

| Issue                                             | Severity     | Detail                                                                                                                                                                                                                 |
| ------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AutoGrowTextarea is embedded in StoryView.tsx** | Should-fix   | 120-line general-purpose component (lines 255–335) defined inside the module. Used by both the composer and tap-to-edit. No StoryView-specific coupling beyond definition location. Extract to `AutoGrowTextarea.tsx`. |
| **StoryPanel is a 372B pass-through**             | Nice-to-have | Just renders `<StoryView storyId={...} phase={...} ... />`. Exists so the Registry can map `story:play` to something other than StoryView directly. Could inline into Registry or eliminate.                           |
| **Nav mixes 3 concerns**                          | Nice-to-have | Tab open/close state, column resize mouse handling, panel rendering — all in one 127-line component. Reasonable size, but the resize logic is a candidate for `useColumnResize.ts`.                                    |
| **Flat directory (F-040)**                        | Should-fix   | 50+ files in `web/src/`. Clusters exist: views, components, hooks, api, utils. Create subdirectories: `views/`, `components/`, `hooks/`, `api/`, `lib/`.                                                               |

### What Works

- `EntryContent` uses `React.memo` correctly — content/highlightBlocks are primitives, shallow comparison skips re-renders for unchanged posts during streaming.
- `Registry.tsx` + `panel-types.ts` is clean config-driven panel resolution — layout config says what tabs exist, registry maps ids to components.
- `ButtonContainerRow` is a genuinely reusable abstraction — Nav and StoryView both use it with different button configs.
- `PlayTabProvider` uses React Context properly for display settings that multiple components read.

---

## 3. CSS Convention Assessment

**Clinerules claim:** "Config-driven layout, no fixed pixel values, relative/proportional units."

**Reality: Partial adherence.**

### Adherence (good)

- `global-css-settings.ts` injects a `<style>` tag with CSS custom properties (`--text`, `--bg`, `--border`, `--accent`, etc.) from server-persisted config. Light/dark mode via `prefers-color-scheme`.
- Many components use `var(--border)`, `var(--text)`, `var(--bg)` correctly.
- Font size uses `var(--entry-font-size)` in `.entry` and `.composer textarea`.
- `index.css` uses CSS custom properties for theming, `@media (prefers-color-scheme: dark)` for dark mode overrides.
- `App.css` uses `var(--app-height, 100dvh)` for mobile viewport handling.

### Violations

| Location           | Pattern                    | Count    | Detail                                                                                                                          |
| ------------------ | -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `index.css`        | Hardcoded px dimensions    | ~12      | `#root width: 1126px`, `h1 font-size: 56px`, `h2 font-size: 24px`, `margin: 32px 0`, `letter-spacing: -1.68px`, etc.            |
| Multiple CSS files | `font-size: 15px`          | 5 sites  | AgentsView, ArchivesView, MemoryView, PromptsView, WorldbookView — should use a custom property                                 |
| Various CSS files  | `max-width: Npx`           | ~8 sites | 1200px, 900px, 800px, 480px, 420px, 320px, 220px, 55px, 42px                                                                    |
| `StoryView.css`    | Hardcoded hex in selectors | 2        | `#3a3a3a` for `.mode-toggle button.active` and `.play-toolbar button.active`                                                    |
| 9 CSS files        | Hardcoded hex colors       | ~40      | Error colors (`#d9534f`, `#ffb4b4`), borders (`#444`, `#333`), backgrounds (`#1a1a1a`, `#161616`), accent overrides (`#d9a441`) |
| `ToastHost.css`    | Severity-level colors      | 10       | Full palette for info/warning/error/critical toasts — not config-driven                                                         |

### Verdict

The config-driven infrastructure exists (`global-css-settings.ts` + CSS custom properties) and is **used by about 60% of CSS rules**. The remaining 40% hardcode values directly. The gap is not architectural — the pattern works — it's incomplete application. A systematic pass to replace hardcoded colors/dimensions with custom property references would close most of the gap. The `font-size: 15px` repetition across 5 files is the most obvious win: one `--entry-font-size` custom property already exists and is used in `App.css`.

---

## 4. Rendering Patterns Assessment

### Re-render Traps

| Pattern                     | Location               | Impact                                                                                                                                                                                                                                                                                                                            | Fix                                                                                                                                                                                                                                                                                                   |
| --------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`forceTick` 1s interval** | StoryView.tsx:627–653  | Full StoryView re-render every second while any generation is pending. Rebuilds entire log DOM via `shown.map()`.                                                                                                                                                                                                                 | Replace `forceTick` + `setInterval` with a `useRef` timestamp + direct DOM text update on elapsed labels. The status label string (`pendingStatusLabel`) only needs to update the visible text; everything else derives from the stream/job state changes which already trigger their own re-renders. |
| **Inline arrow fns in JSX** | StoryView.tsx: 8 sites | `onClick={() => void loadEarlier()}`, `onClick={() => void cancelJob(...)}`, `onClick={() => setError(null)}`, `onClick={() => void saveEdit()}`, `onClick={() => void forkFromEdit()}`, `onClick={() => void handleKickoff()}` — each creates a new function reference every render, defeating `React.memo` on child components. | Wrap in `useCallback` or extract into named handler functions. The `onClick={() => void loadEarlier()}` pattern is the most common — a single `handleLoadEarlier = useCallback(() => void loadEarlier(), [...deps])` would cover it.                                                                  |
| **Inline object creation**  | None significant       | `DEFAULT_INPUT_BAR` is a module-level constant, not recreated per render.                                                                                                                                                                                                                                                         | —                                                                                                                                                                                                                                                                                                     |

### What Works

- `EntryContent` is `React.memo`-wrapped with primitive props — shallow comparison correctly skips unchanged posts.
- `handleLogClick` uses event delegation on `.log` container instead of per-entry `onClick` props — the right approach for a list that re-renders on every streamed token.
- Every `.map()` has proper `key` props — no missing-key warnings.
- `useMemo` on `reasoningTraces` (line 433) avoids re-reading localStorage on every render.
- `pendingTailSignature` (line 607) is `useMemo`-derived — clean signal for scroll hook.

### Verdict

One real performance issue (`forceTick` timer) and ~8 cosmetic inline-function sites. No structural re-render disaster. The `forceTick` pattern is the highest-impact fix: eliminating the 1s full-render from a 51KB component during generation (the most common active state) would be the single biggest responsiveness win.

---

## 5. State Management Assessment

**Clinerules claim:** "No state management library — React state + fetch."

**Reality:** Heavily useState-based with localStorage for cross-session persistence. No useReducer despite complex interdependent state in StoryView.

### StoryView State (13 useState calls + 3 useRef)

| State               | Type                           | Purpose                                                     |
| ------------------- | ------------------------------ | ----------------------------------------------------------- |
| `mode`              | `'guide' \| 'play'`            | IC/OOC toggle, persisted to localStorage                    |
| `entries`           | `LogEntry[]`                   | Currently loaded log window (≤80 entries)                   |
| `hasMoreEntries`    | `boolean`                      | Whether older entries exist beyond window                   |
| `loadingEarlier`    | `boolean`                      | "Load earlier" button in-flight                             |
| `position`          | `Position \| null`             | Undo/redo cursor position                                   |
| `draft`             | `string`                       | Composer textarea value                                     |
| `pendingReplies`    | `Record<string, PendingReply>` | Live streaming replies keyed by agentPageId                 |
| `hiddenPending`     | `Set<string>`                  | PageIds hidden from log (uncancellable jobs)                |
| `error`             | `string \| null`               | Error banner message                                        |
| `starting`          | `boolean`                      | Serialized action round-trip guard (kickoff/continue/retry) |
| `editingPageId`     | `string \| null`               | Which post is in tap-to-edit mode                           |
| `editDraft`         | `string`                       | Edit textarea value                                         |
| `editInitialHeight` | `number \| undefined`          | Seed height for AutoGrowTextarea in edit mode               |

Plus 3 refs: `editTextareaRef`, `pendingCaretRef`, `pendingScrollRestoreRef`.

**These form an interdependent state machine:**

- `pendingReplies` → `pendingTailSignature` → `useStoryLogScroll`
- `pendingReplies` + `starting` → `busy` derivation
- `editingPageId` gates `handleLogClick`, composer, toolbar, submit
- `position` + `entries` → `shown` derivation (what's visible after undo)
- `entries` + `pendingReplies` + `hiddenPending` + `mode` → `visible` → `shown` + `pendingEntries`
- `pendingReplies` drives `forceTick` polling effect
- `position.atHead` gates `useStoryLogScroll` follow behavior

This is the textbook case for `useReducer`: multiple state fields that co-transition (e.g., `watchJob` → sets pendingReplies, error, starting, hiddenPending in a cascade). 13 useState calls with interdependent effects is fragile and hard to reason about.

### Cross-View Coordination

| Mechanism      | What                                               | Where                                    |
| -------------- | -------------------------------------------------- | ---------------------------------------- |
| localStorage   | Selected story ID                                  | App.tsx → Nav (tab persistence)          |
| localStorage   | Story mode (IC/OOC)                                | StoryView.tsx                            |
| localStorage   | Story toggle indices                               | StoryToggles.tsx                         |
| localStorage   | Open tab IDs + widths                              | Nav.tsx                                  |
| localStorage   | Reasoning display prefs                            | ReasoningDisplay.tsx                     |
| React Context  | Play tab display settings                          | PlayTabProvider → RoleLabel, StoryView   |
| Props drilling | `story`, `phase`, `onStoryChange`, `onPhaseChange` | App → Nav → every panel via `PanelProps` |

**No server cache layer.** Every view fetches its data on mount via `useEffect` + api call. The only dedup is `api-limiter.ts`'s in-flight GET dedup (same URL + method → single request, both callers get clones). No stale-while-revalidate, no cache invalidation on mutation. Each view that polls (WorldbookView 3s, SegmentsView 3s) does so independently — no shared polling coordination.

### Verdict

**The "no state library" clinerules claim was not an intentional decision — it's been reconsidered.** The current approach (13 useState + scattered localStorage + per-view refetch-on-mount) causes real friction at the app's current scale (2,600-post logs, multiple polling views).

**Decided approach (2026-07-13):**

| Layer                            | Tool               | Rationale                                                                                                                                                                                                                            |
| -------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Server state**                 | **TanStack Query** | Cache server responses, stale-while-revalidate on tab switches, shared polling intervals, automatic invalidation on mutation. Replaces the per-view `useEffect` + fetch pattern and `api-limiter.ts`'s partial dedup. ~12KB gzipped. |
| **StoryView client state**       | **useReducer**     | Collapses 13 interdependent useState calls into explicit state transitions (`WATCH_JOB`, `STREAM_TOKEN`, `JOB_DONE`, `START_EDIT`, etc.). Free, no dependency, React-native.                                                         |
| **Cross-component client state** | **Zustand**        | Single store for shared client state with `persist` middleware replacing the scattered localStorage patterns (§10). ~1KB gzipped.                                                                                                    |

---

## 6. api.ts Assessment (32.7KB, ~1,080 lines)

### Internal Organization

The file is a flat list of exports in this order:

1. Session management (claim, get/set sessionId, superseded listener)
2. User profiles (fetchUsers)
3. apiFetch wrapper (private, ~55 lines)
4. Account (fetch, updateDisplayName, changePassword, API keys)
5. Layout (fetch, update)
6. Settings spaces (generic fetch/save/revert — typed via generic param)
7. Prompts (fetch)
8. Jobs (fetch, fetchSlots, cancel, fetchActiveJobs)
9. Prompt preview (fetchPromptPreview)
10. Model configs (CRUD + catalog + reorder)
11. Stories (rename, list, create, delete)
12. Story-to-date segments (CRUD + backfill + enqueue + requeue)
13. **Archives (DEPRECATED)** — ArchiveEntry, ArchivePage types + 6 functions (fetchArchives, backfillArchiveNames, queueArchiveDecad, updateArchive, requeueArchive)
14. Messages (postMessage, retryPost, editPost, continuePost, postSetupMessage, kickoff, startOocSession)
15. Position (fetch, undo, redo, jumpTo)
16. Fork
17. Worldbook (CRUD + compact)
18. Job streaming (streamJob — the largest single function at ~65 lines)

### Problems

| Issue                            | Detail                                                                                                                                                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dead archive code (86 lines)** | `ArchiveEntry`, `ArchivePage`, `fetchArchives`, `backfillArchiveNames`, `queueArchiveDecad`, `updateArchive`, `requeueArchive` — all `@deprecated`, all calling routes that no longer exist on the backend. Not imported anywhere in `web/src/`. Remove. |
| **No request builder**           | Every function manually constructs URL + params + headers + body. `fetchSettingsSpace` does it well (generic), but story-to-date, archives, and worldbook repeat the same pattern 15+ times.                                                             |
| **`as` casts on JSON**           | `return res.json() as Promise<ArchivePage>` — no runtime validation of the response shape. A backend change silently produces runtime errors in the consumer.                                                                                            |
| **Monolithic file**              | All resources in one file. Adding a story-to-date endpoint means editing a 1,080-line file to find the right section.                                                                                                                                    |
| **No separation of types**       | All TypeScript interfaces (Story, Job, ModelConfig, WorldbookEntry, LogEntry, etc.) are inline in api.ts. No shared types module.                                                                                                                        |

### Proposed Split

```
web/src/api/
├── client.ts          # apiFetch wrapper, session helpers, API_BASE, onSuperseded
├── types.ts           # Shared types: Story, Job, LogEntry, ModelConfig, etc.
├── account.ts         # fetchAccount, updateDisplayName, changePassword, API keys
├── stories.ts         # listStories, createStory, deleteStory, renameStory, fetchPhase
├── messages.ts        # postMessage, retryPost, editPost, continuePost, kickoff, postSetupMessage, startOocSession
├── story-to-date.ts   # fetchStoryToDate, update/delete/enqueue/requeue/backfill segment
├── worldbook.ts       # fetchWorldbook, create/update entry, compactWorldbook
├── agents.ts          # Model config CRUD, catalog, reorder
├── layout.ts          # fetchLayout, updateLayout
├── settings.ts        # fetchSettingsSpace, saveSettingsSpace, revertSettingsSpace
├── jobs.ts            # fetchJobs, fetchSlots, cancelJob, fetchActiveJobs, streamJob
├── position.ts        # fetchPosition, undo, redo, jumpTo, fork
└── prompts.ts         # fetchPrompts, fetchPromptPreview
```

This is the split recommended by F-039. The key invariant: `api-limiter.ts` stays as-is (it wraps `fetch`, not `apiFetch` — it's a lower layer). `apiFetch` in `client.ts` uses `coordinatedFetch` from `api-limiter.ts`. Every resource module imports `apiFetch` from `client.ts`.

---

## 7. toast.ts vs Sonner

### Current: hand-rolled (95 lines)

```
toast.ts → ToastHost.tsx → ToastHost.css
         → error-capture.ts (global console.error → toast bridge)
         → StoryView.tsx (toast.info for uncancellable jobs)
```

Features: severity levels (info/warning/error/critical), auto-dismiss with configurable durations (4s/6s/8s/∞), backend reporting for non-info, global error capture bridge.

### Sonner (`sonner`)

- **Stacking:** Proper toast stack with enter/exit animations. Current: simple prepend, no transitions.
- **Accessibility:** `role="status"`, `aria-live="polite"` built in. Current: none.
- **Rich toasts:** Promise toasts, action buttons, custom JSX. Current: title + message only.
- **Theming:** CSS variables or Tailwind. Current: hardcoded hex in `ToastHost.css`.
- **API:** `toast.error("msg")` — drop-in replacement for current `toast.error("msg")`.
- **Size:** ~4KB gzipped (one dependency).

### Verdict: **Replace with Sonner.**

The current system works and is well-integrated (the `error-capture.ts` bridge is the most valuable piece). But 95 lines of pub/sub + dismiss timer + DOM rendering + CSS for severity levels is exactly the problem Sonner solves. The API is compatible (`toast.error(msg)` → `toast.error(msg)`). The migration is:

1. `npm install sonner` in `web/`
2. Replace `error-capture.ts`'s `toast.error/critical` calls with Sonner's
3. Replace `StoryView.tsx`'s `toast.info` call
4. Delete `toast.ts`, `ToastHost.tsx`, `ToastHost.css`
5. Add `<Toaster />` to App.tsx

Estimated effort: 30 minutes. Risk: near-zero — Sonner is mature, tree-shakeable, and the API surface is strictly larger than what's currently used.

---

## 8. useStoryLogScroll.ts vs Virtuoso

**Updated analysis** (user correction: real play log is 1,600 IC posts, 2,600 total including hidden/retried).

### Current: hand-rolled (135 lines)

Manages a regular `<div className="log">` with:

- `scrollTop` manipulation for pin-to-bottom on streaming
- Prepend-restore: saves scroll distance before `loadEarlier`, restores after
- Keyboard/viewport resize compensation
- Edit-mode protection (no auto-scroll while editing)

With `LOG_PAGE_SIZE=80` and 2,600 entries, reaching log head requires ~32 manual "load earlier" clicks. Each click fetches a batch, prepends, and restores scroll position. This is a **real UX friction point** for the primary use case.

### Virtuoso (`react-virtuoso`)

- **Virtualized list:** Renders only visible rows + overscan buffer. DOM size stays constant regardless of log length.
- **Dynamic sizing:** Items can vary in height (posts with reasoning traces, worldbook blocks, etc.) — Virtuoso handles this.
- **Follow output:** `followOutput` prop → auto-scroll to bottom on new content. Equivalent to the pin-to-bottom logic.
- **Prepend:** `firstItemIndex` + `initialTopMostItemIndex` for "load earlier" — scroll position is maintained by the virtualizer.
- **Size:** ~10KB gzipped.

### react-window (`react-window`)

- Lower-level: fixed-size items only. Dynamic post heights (variable content, reasoning panels) would require `VariableSizeList` + manual size measurement. More code to write, less benefit.

### Tradeoff

| Factor                   | Current                                            | Virtuoso                                                         |
| ------------------------ | -------------------------------------------------- | ---------------------------------------------------------------- |
| DOM size                 | Grows with loaded window (≤80 entries × DOM nodes) | Constant (visible rows + overscan)                               |
| Load earlier UX          | Manual click, fetch, scroll-restore                | Continuous scroll, no manual action                              |
| Scroll logic             | 135 lines of custom code                           | `followOutput` + `atBottomStateChange`                           |
| Edit mode protection     | Handled in useStoryLogScroll                       | Would need reimplementation with Virtuoso's callback API         |
| Prepending older content | 15 lines of scroll-restore logic                   | `firstItemIndex` API                                             |
| Mobile keyboard handling | useVisualViewport + useStoryLogScroll coordinate   | Virtuoso doesn't handle viewport resize; useVisualViewport stays |

### Verdict: **Replace with Virtuoso.**

The 2600-post real-world log makes this a **should-fix, not nice-to-have**. 32 "load earlier" clicks to reach log head is a real UX problem for the primary use case (reading back through a long story). Virtuoso's `followOutput` and `firstItemIndex` APIs cover the core scroll behaviors. The edit-mode protection and keyboard handling would need porting to Virtuoso's callback API, but that's one-time work replacing 135 lines of custom scroll code.

Estimated effort: 2–3 hours. The primary risk is that the tap-to-edit flow (swap a post's content for an AutoGrowTextarea in-place) works with a virtualized list — Virtuoso supports variable-height items, so a post growing during edit should resize correctly, but this needs explicit testing.

---

## 9. Dead Code & Stale Files

| Item                         | Detail                                                                                                                              | Action                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **api.ts archive section**   | `ArchiveEntry`, `ArchivePage` types + 6 functions (lines 693–778). `@deprecated`, backend routes deleted. Not imported by any file. | Delete.                                         |
| **ArchivesView.css (3.5KB)** | `SegmentsView.tsx` imports `./ArchivesView.css`. Component renamed, CSS file not.                                                   | Rename to `SegmentsView.css` and update import. |
| **MemoryView.css (702B)**    | `ContextView.tsx` imports `./MemoryView.css`. Component renamed, CSS file not.                                                      | Rename to `ContextView.css` and update import.  |
| **bun.lock at repo root**    | F-004 still outstanding. Not frontend-specific but affects all `web/` work.                                                         | Delete.                                         |

---

## 10. localStorage Key Sprawl

Seven different key patterns across seven files, each invented independently:

| Key                                                 | File                   | Pattern                      |
| --------------------------------------------------- | ---------------------- | ---------------------------- |
| `loremaster.sessionId`                              | api.ts                 | `SESSION_STORAGE_KEY`        |
| `loremaster.userId`                                 | api.ts                 | `USER_STORAGE_KEY`           |
| `loremaster.selectedStoryId`                        | App.tsx                | `SELECTED_STORY_STORAGE_KEY` |
| `loremaster.storyMode.${id}`                        | StoryView.tsx          | `modeStorageKey()`           |
| `loremaster.storyToggles.${id}`                     | StoryToggles.tsx       | `storageKey()`               |
| `loremaster.openTabs`                               | Nav.tsx                | `OPEN_TABS_STORAGE_KEY`      |
| `loremaster.containerCollapsed.${scope}.${id}`      | ButtonContainerRow.tsx | `COLLAPSE_STORAGE_PREFIX`    |
| `loremaster.reasoning.{show,expanded,traces.${id}}` | ReasoningDisplay.tsx   | Multiple inline strings      |

**Recommendation:** Create `web/src/lib/storage-keys.ts` with a single `STORAGE_KEY` namespace:

```ts
export const STORAGE_KEY = {
  sessionId: 'loremaster.sessionId',
  userId: 'loremaster.userId',
  selectedStoryId: 'loremaster.selectedStoryId',
  storyMode: (storyId: string) => `loremaster.storyMode.${storyId}`,
  storyToggles: (storyId: string) => `loremaster.storyToggles.${storyId}`,
  openTabs: 'loremaster.openTabs',
  containerCollapsed: (scope: string, id: string) => `loremaster.containerCollapsed.${scope}.${id}`,
  reasoningShow: 'loremaster.reasoning.show',
  reasoningExpanded: 'loremaster.reasoning.expanded',
  reasoningTraces: (storyId: string) => `loremaster.reasoning.traces.${storyId}`,
} as const
```

This is a 5-minute change with zero behavioral impact and makes the key surface discoverable.

---

## 11. Gaps vs Market Solutions

The user benchmarks against **KoboldAI** (KAI) and **SillyTavern** (ST).

### What Loremaster Already Does Better

| Capability                | KAI                           | ST                            | Loremaster                                            |
| ------------------------- | ----------------------------- | ----------------------------- | ----------------------------------------------------- |
| Worldbook auto-curation   | ❌ Manual                     | ❌ Manual                     | ✅ Guided setup worldbook extraction from OOC chat    |
| Context limit management  | ❌ None                       | ✅ Visual indicator           | ✅ Story-to-date rolling compression keeps early lore |
| Long-session memory       | ❌ Head loss → flanderization | ❌ Head loss → flanderization | ✅ Recursive lore compression + worldbook injection   |
| Multi-user / server model | ❌ Local only                 | ✅ Session storage            | ✅ Client-server, pick up from any device             |
| Edit friction             | ✅ In-place, no jump          | Mixed                         | ✅ In-place AutoGrowTextarea, no layout jump          |
| Menu clutter              | ✅ Lean                       | ❌ Massive                    | ✅ Config-driven layout, data decides what's shown    |

### Where Loremaster Lags

| Capability                       | KAI                       | ST                                     | Loremaster Gap                                                                |
| -------------------------------- | ------------------------- | -------------------------------------- | ----------------------------------------------------------------------------- |
| **Context budget visualization** | ❌                        | ✅ Tokens used by prompt/worldbook/log | No budget breakdown shown to user                                             |
| **Last response metadata**       | ✅ "X model in Y seconds" | ✅ Click for prompt info               | No per-response metadata visible (model, timing, token count)                 |
| **Provider breadth**             | ✅ Many out of box        | ✅ Many                                | Featherless + Horde only (but provider adapter is a planned backend refactor) |
| **TTS / avatars**                | ❌                        | ✅                                     | Out of scope                                                                  |
| **Prompt structure visibility**  | ❌                        | ✅                                     | ContextView shows full prompt preview ✅                                      |
| **Continuous log scroll**        | ✅ Full log scrollable    | ✅ Full log scrollable                 | ❌ 80-entry window + "load earlier" pagination (this is the Virtuoso gap)     |
| **Worldbook manual override**    | ✅                        | ✅                                     | ✅ WorldbookView supports manual entries                                      |
| **Guided retry/continue**        | ❌                        | ✅ (via plugin)                        | ✅ Draft text used as guidance for retry/continue                             |

### Key Insight

The only structural gap vs both market solutions is **continuous log scrolling** — both KAI and ST let you scroll through the full history without pagination. This is the Virtuoso item (§8) and is now a **should-fix priority** given the 2,600-post real-world log. Everything else Loremaster already handles or is out of scope (avatars, TTS, provider breadth through the planned backend adapter).

---

## 12. Core Domain Touchpoints

The frontend must not break these backend systems during refactor. Each is a touchpoint to verify after changes.

| Backend System                           | Frontend Touchpoint                                                                                                                                        | Risk During Refactor                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Story-to-date** (rolling compression)  | `SegmentsView.tsx` — segment CRUD, enqueue, backfill; `api.ts` story-to-date functions                                                                     | Low — api.ts split just moves functions                                      |
| **Worldbook** (prompt injection entries) | `WorldbookView.tsx` — create/edit/compact entries; `EntryContent.tsx` — `highlightBlocks` rendering; `worldbookBlocks.ts` — must stay in sync with backend | Medium — `worldbookBlocks.ts` is a shared contract                           |
| **Context pipeline** (prompt assembly)   | `ContextView.tsx` — prompt preview render; `prompt-block.ts` — block classification                                                                        | Low                                                                          |
| **Job streaming** (SSE)                  | `StoryView.tsx` — `streamJob` + `watchJob` + `pendingReplies` state machine; `api.ts` — `streamJob` function                                               | High — StoryView's streaming state machine is the most complex frontend code |
| **Session guard** (claim/reclaim)        | `ClaimGate.tsx`, `App.tsx` — onSuperseded listener; `api.ts` — claimSession, apiFetch 409 handling                                                         | Medium — apiFetch split must preserve the 409 → onSuperseded path            |
| **Layout config**                        | `Nav.tsx`, `ButtonContainerRow.tsx`, `Registry.tsx`, `layoutUtils.ts` — config-driven tab/button rendering                                                 | Low                                                                          |
| **Inference provider config**            | `AgentsView.tsx`, `ApiKeysSection.tsx` — model config CRUD + API key management                                                                            | Low                                                                          |

---

## 13. Proposed Phased Plan

### Phase 1: Cleanup (low risk, high leverage)

| #   | Item                                                                            | Effort | Prerequisite for                |
| --- | ------------------------------------------------------------------------------- | ------ | ------------------------------- |
| 1.1 | Delete dead archive code from api.ts (86 lines)                                 | 5 min  | Phase 3 api.ts split            |
| 1.2 | Rename ArchivesView.css → SegmentsView.css, MemoryView.css → ContextView.css    | 5 min  | Phase 4 subdirectories          |
| 1.3 | Create `web/src/lib/storage-keys.ts` and migrate all localStorage keys          | 15 min | Ongoing maintainability         |
| 1.4 | Delete `bun.lock` at repo root (F-004)                                          | 1 min  | —                               |
| 1.5 | Extract AutoGrowTextarea from StoryView.tsx → `components/AutoGrowTextarea.tsx` | 15 min | Phase 2 StoryView decomposition |

### Phase 2: StoryView Decomposition (F-038)

| #   | Item                                                                                            | Effort | Depends on |
| --- | ----------------------------------------------------------------------------------------------- | ------ | ---------- |
| 2.1 | Add `useReducer` for StoryView's interdependent state (13 useState → 1 useReducer)              | 1–2 hr | 1.5        |
| 2.2 | Extract `StoryLog.tsx` from StoryView (the `.log` div + `shown.map()` + `pendingEntries.map()`) | 1 hr   | 2.1        |
| 2.3 | Extract `StoryFooter.tsx` (toolbar + composer + error banner)                                   | 30 min | 2.1        |
| 2.4 | Replace `forceTick` timer with `useRef` + direct DOM elapsed-label update                       | 30 min | 2.1        |
| 2.5 | Wrap inline onClick handlers in `useCallback`                                                   | 15 min | 2.1        |

### Phase 3: api.ts Split (F-039)

| #   | Item                                                                                                                       | Effort | Depends on |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- |
| 3.1 | Create `web/src/api/` directory with `client.ts` + `types.ts`                                                              | 15 min | 1.1        |
| 3.2 | Split by resource: stories, messages, story-to-date, worldbook, agents, layout, settings, jobs, position, prompts, account | 1–2 hr | 3.1        |
| 3.3 | Update all imports across web/src/ (grep + replace)                                                                        | 30 min | 3.2        |
| 3.4 | Verify: `npm run typecheck` + `npm run lint` from `web/`                                                                   | 5 min  | 3.3        |

### Phase 4: State Infrastructure ✅

| #   | Item                                                                 | Status | Notes                                                                                                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1 | Install TanStack Query + Zustand                                     | ✅     |                                                                                                                                                                                                                                                                                                                               |
| 4.2 | Add `QueryClientProvider` to App.tsx                                 | ✅     |                                                                                                                                                                                                                                                                                                                               |
| 4.3 | Create Zustand store with `persist` middleware                       | ✅     | Single `loremaster.ui` key, `version: 1`, one-time migration from old individual keys via `readOldKeys()`                                                                                                                                                                                                                     |
| 4.4 | Migrate localStorage to Zustand `persist` — delete `storage-keys.ts` | ✅     | 6 consumers migrated: App.tsx, Nav.tsx, ButtonContainerRow.tsx, ReasoningDisplay.tsx, StoryToggles.tsx, StoryView.tsx. Session/user ID keys inlined into api/client.ts and api/account.ts. `storage-keys.ts` deleted.                                                                                                         |
| 4.5 | Wrap api modules in TanStack Query hooks                             | ✅     | 12 hook files: use-stories, use-layout, use-agents, use-worldbook, use-worldbook-mutations, use-story-to-date, use-segment-mutations, use-prompts, use-account, use-jobs, use-position, use-messages, use-settings                                                                                                            |
| 4.6 | Replace per-view `useEffect` + fetch with `useQuery` hooks           | ✅     | 9 views migrated: PromptsView, ContextView, LogsView, QueueView, SavesView, WorldbookView, SegmentsView, AgentsView, AccountSettings. ClaimGate/App.tsx bootstrap kept as direct API (outside QueryClientProvider). PreferencesView/PlayTabSettings/global-css-settings kept as one-shot fetch (no polling, no shared cache). |
| 4.7 | Replace polling intervals with `refetchInterval`                     | ✅     | LogsView (2s), QueueView (2s), WorldbookView (3s), SegmentsView (3s)                                                                                                                                                                                                                                                          |
| 4.8 | Verify typecheck + lint                                              | ✅     | 0 typecheck errors, 0 lint errors, 1 pre-existing warning (forceTick exhaustive-deps, intentionally kept). Production build succeeds (382KB JS / 115KB gzipped).                                                                                                                                                              |

### Phase 5: Web/src/ Subdirectories (F-040) ✅

| #   | Item                                                                 | Status | Notes                                                                                                                                                                                                                                                                                                                             |
| --- | -------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1 | Create `views/`, `components/`, `hooks/`, `api/`, `lib/` directories | ✅     | `views/` created; others already existed from Phase 3/4                                                                                                                                                                                                                                                                           |
| 5.2 | Move files to subdirectories and update imports                      | ✅     | 15 view files + CSS → `views/`, 10 components + CSS → `components/`, 2 hooks → `hooks/`, 9 utility files → `lib/`. ~60 import paths updated. Fixed `ButtonContainerRow` regression (`showButton === false` → `!container.visible`). Fixed `SegmentsView` anti-pattern (render-body `mutateAsync` → `useEffect` + `useRef` guard). |
| 5.3 | Verify typecheck + lint                                              | ✅     | 0 typecheck errors, 0 lint errors, build passes                                                                                                                                                                                                                                                                                   |

### Phase 6: Package Replacements ✅

| #   | Item                                            | Status | Notes                                                                                                                                                                                                                                                                               |
| --- | ----------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.1 | Replace toast.ts with Sonner                    | ✅     | Thin wrapper in `lib/toast.ts` preserves `toast.info/warning/error/critical(message, title?)` API + `reportToBackend`. Deleted `ToastHost.tsx`/`.css`. `<Toaster position="bottom-right" />` in `main.tsx`. +9KB gzipped.                                                           |
| 6.2 | Replace useStoryLogScroll with Virtuoso         | ✅     | Rewrote `StoryLog.tsx` with `followOutput`, `atTopStateChange`, `firstItemIndex` (ref-tracked prepends), `Header` for loading state. Extracted `EditEntry` subcomponent. Deleted `useStoryLogScroll.ts`. Changed `.log` CSS `overflow-y: auto` → `overflow: hidden`. +19KB gzipped. |
| 6.3 | E2E smoke test: critical-path.spec.ts (7 tests) | ✅     | 7/7 pass. Root cause of initial failure: `ButtonContainerRow` used `showButton === false` instead of `!container.visible` — all input containers have `showButton: false`, toolbar rendered with height 0.                                                                          |

### Phase 7: CSS Convention Cleanup ✅

| #   | Item                                                                             | Status | Notes                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 7.1 | Replace hardcoded `font-size: 15px` with `var(--entry-font-size)` across 5 files | ✅     | 6 CSS files updated (AgentsView, ContextView, PromptsView, SegmentsView, WorldbookView, index.css code)                                                                              |
| 7.2 | Replace hardcoded hex colors with CSS custom properties                          | ✅     | 9 semantic color vars added to `:root` + dark theme (`--danger`, `--warning`, `--info`, `--surface`, `--border-strong`, etc.). 28 hardcoded hex colors replaced across 10 CSS files. |
| 7.3 | Audit remaining px dimensions                                                    | ✅     | All remaining px values are functional constraints (scrollbar widths, resize handles, border widths, border-radius, component max-heights). No changes needed.                       |

## 14. Items for Discussion

These need explicit user decision before locking in:

0. **State library approach** — **[DECIDED]** TanStack Query for server state, useReducer for StoryView, Zustand for cross-component client state + localStorage persistence. Rationale in §5.
1. **Sonner vs react-hot-toast** — **[DECIDED]** Sonner. Tiebreaker: the `action` prop for retry/dismiss buttons on error toasts. Migration: 5 call sites, drop-in API match.
2. **Virtuoso vs react-window** — **[DECIDED]** Virtuoso. Tiebreaker: dynamic post heights break react-window's `VariableSizeList` without custom measurement plumbing. Virtuoso's `followOutput` + `firstItemIndex` map directly to the chat-log use case.

3. **api.ts split granularity** — **[DECIDED]** 13 files. Each mirrors a backend route domain and gives Phase 4's TanStack Query hooks a clean 1:1 module mapping. The two 2-function files (`layout.ts`, `prompts.ts`) define boundaries, not line-count minimums.

4. **CSS config-driven scope** — **[DECIDED]** Both tiers. Tier 1: replace brand colors + `font-size: 15px` repetition with custom properties. Tier 2: add `var(--x, fallback)` wrappers to remaining hardcoded layout/typography values. Scrollbar widths, resize handles, and component-specific max-heights stay as-is (functional constraints, not theming).

5. **Settings editor UX** — **[DECIDED]** Option C: split approach. Schema-driven forms for global CSS, play tab, and banned phrases (3 spaces users actually touch). Validated JSON textarea for layout config and toggle presets (4 structural spaces). json-edit-react removed entirely. Zero new dependencies. Layout/toggle preset handling deferred — revisit after the forms are in place and user can assess feel.

6. **Virtuoso + tap-to-edit verification** — **[DECIDED]** Verification gate before Phase 6.2 merge. Run E2E tests (`critical-path.spec.ts` — 16 tests) on a Virtuoso-integrated branch. Manual smoke: edit-short→long, edit-long→short, edit-mid-log-while-streaming, edit-near-bottom, mobile keyboard. 2-hour spike. If any scenario fundamentally fails → revert, keep `useStoryLogScroll.ts`, document finding.

7. **Phase ordering** — **[DECIDED]** 1→2→3→4→5→6→7 as listed in §13. The only hard dependency: Phase 2.2 (extract `StoryLog.tsx`) must complete before Phase 6.2 (Virtuoso) — makes the swap a single-component replacement instead of surgery on a 1,335-line file. Phases 3, 5, 7 are independent.

---

**All items decided. All phases (1–7) complete.**
---

_Frontend refactor complete. Bundle: 143KB gzipped JS (was 115KB pre-Phase 6)._
