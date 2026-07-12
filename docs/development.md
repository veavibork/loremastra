# Loremaster development log

Detailed milestone history and implementation notes. For a scannable backlog of open work only,
see [roadmap.md](roadmap.md).

Two checkpoints ahead: **Vertical Slice** (every core mechanism touched at least once, end-to-end, with
a minimal real UI) and **Phase 1 Complete** (everything loremaster.md scopes to Phase 1, excluding the
Future Phases appendix). Still building one step at a time — this exists so "push on to something else"
has a target, not so we jump ahead of confirming each step.

**Current status (2026-07-05):** Phase 1 Complete modulo the two explicitly deferred security items
(encryption at rest for story content, per-user file-level isolation). Multi-user auth, per-user encrypted
API keys, story-to-date memory, worldbook + tags, setup/kickoff, post controls + branching, config-driven
layout, MCP dev server, and Horde as a second provider are all shipped and proven. See below for
post-Phase-1 incremental work (2026-07-05+).

## Done so far (proven, not full-featured)

- Two-tier SQLite storage (global DB + per-story files), book/page/text generic content schema.
- Job queue: durable job table, cost-based concurrency slots, timeouts, stale-job recovery on restart,
  handshake+poll+SSE client protocol (no more silent-hang class of bugs).
- Tags: mutable tag cloud, retroactive grep indexing (both directions — new content vs. existing tags).
  Tag activation from query (latest user message + ~2 assistant turns). **2026-07-04:** assembly no
  longer promotes compress/archive tiers; tags drive worldbook ROSTER/MEMORY injection only.
- Real Featherless integration: streaming author calls, forced tool-calling, model catalog + tag-rating
  scaffold for role-based model discovery.
- Minimal React UI: single story, post a message, watch it stream in.
- **Retired 2026-07-04:** archive tier + decad prompt assembly (see Story-to-date memory above).
- Worldbook + Tags UI (Milestone B) — verified end-to-end 2026-07-01: `worldbook_entry` table keyed to
  `page.id` (reuses existing page/text versioning — edits are `createRetryText`, giving version history
  for free; singleton enforcement for Setting/Register/PC via partial unique indexes, not just app-layer
  discipline). `assembleAuthorPrompt` now implements the doc's steps 3-4 (always-include Register/Setting/
  PC, tag-triggered worldbook entries) and the tag-priority ordering rule for steps 7-8 (tags without a
  worldbook entry promoted before tags that already have one). Minimal Lore UI (tag cloud + worldbook
  list/edit, reachable via a Story/Lore tab) is live. Confirmed via direct prompt inspection: Setting/
  Register/PC always appear, and a tagged NPC entry (Halia) was correctly pulled into a real generation
  when the trigger post mentioned her.

Caught and fixed one real bug in the process (historical, pre story-to-date): archive jobs were hardcoded to `slotCost: 1` — fixed via `concurrencyCost` from agent profiles; see docs/featherless-notes.md.

Also fixed along the way: the CORS `Access-Control-Allow-Methods` header (both the global one in
`src/index.ts` and the one in `stories.ts`) was missing `PATCH`, which would have silently broken the
tags PATCH route's preflight from a real browser (curl doesn't preflight, so this went unnoticed until
now).

Creature/Faction field shapes: loremaster.md doesn't spell out explicit "Fields:" lists for these two the
way it does for Location and Character. Pulled the actual field lists from lorepebble's `st1.json`
(Setup Assistant card) instead, per explicit instruction — Creature: identity, how they think, speech,
wants, disposition, do-not; Faction: identity, how they appear, stance toward the PC, leader.

## Story-to-date memory (2026-07-04) — ✅ done

Replaced the KAI-style compress + decad archive pipeline with rolling `[STORY TO DATE]` Editor segments.
Confirmed via smoke tests and live VM deploy.

**Trigger:** assembled Author prompt ≥ 80% usable context → `story-to-date` Editor job (`begins` or
`continues`). **Assembly:** system → worldbook → merged `[STORY TO DATE]` → verbose tail after last
coverage page only (`src/services/history.ts`).

**Invalidation:** edits/undo/redo/fork inside a segment's coverage window delete that segment (and
later seq) and cancel pending jobs. Legacy `archive` rows purged on DB open (`purgeLegacyArchives`).

**Archives tab:** collapse/expand, edit/save segment content, requeue, token counts, optional Worker
scene titles (`archive-name` on `target_story_to_date_id` — tab display only).

**Retired (do not reintroduce casually):** per-post compress jobs, decad `[EVENT SUMMARY]` blocks,
tag-driven compress/archive promotion in assembly, setup/kickoff archive blocks.

Harness for prompt iteration: `scripts/story-to-date-experiment.ts`, [story-to-date-experiment.md](story-to-date-experiment.md).

---

## Memory pipeline (KAI-style restoration) — superseded 2026-07-04

The following shipped 2026-07-03 and was **retired** when story-to-date landed. Kept here as history only.

- Per-post compression (5-post lag, `gen_extract`, Worker forced tool calls)
- Decad archive blocks (10-post windows, `[EVENT SUMMARY]`, Editor archive jobs)
- Archive invalidation on edit; compress worker with name roster; tag grep on `gen_extract`

Content stamps (`page.memory_content_stamp`) remain for diagnostics/manifest; compress is not enqueued.
Tag activation and worldbook grep against verbose posts remain live.

**Still deferred (unchanged):** MemoryView stale copy, tag-gen conflicts in play-testing.

---

## Path to Vertical Slice

**A. Archive tier + real prompt assembly** — ✅ done (superseded 2026-07-04 by story-to-date; see above).

**B. Worldbook + Tags UI** — ✅ done.

**C. Setup + Kickoff (Editor agent)** — ✅ done, verified end-to-end 2026-07-01 with a real multi-turn
setup conversation through to a story-phase reply. New: `story_state` table (per-story-db single-row
phase tracker: `setup`/`kickoff`/`story` + `kickoffPageId`); `callWithTools` (auto tool-choice, the
judgment-call counterpart to the forced-tool pattern); `upsert_worldbook_entry` tool, matched by
entryType+name (or isPc for the PC) so the Editor never needs to track internal page ids across turns;
`assembleKickoffPrompt` (worldbook only, deliberately excludes the setup chat transcript so meta-
conversation doesn't leak into the story); guided-retry guidance threaded through as job-scoped in-memory
state, never persisted, per the doc's "not stored as a post." Kickoff reuses the same page across
attempts (retry, not a new page each time) so Back-to-Setup → Kickoff-again doesn't pollute the log chain.

Two real bugs caught via direct testing, not superficial ones:

- **Null tool-call ids**: Featherless sometimes returns `id: null` on some entries when a model calls
  several tools in one turn (observed with DeepSeek-V4-Pro creating an NPC + Location together).
  Passing that through verbatim on the next request got a `422` rejection. Fixed with a synthetic
  fallback id generated client-side. See docs/featherless-notes.md.
- **Field-key casing mismatch**: the Editor's tool prompt showed human-readable labels ("Identity",
  "Off the table"), and the model reliably mirrored that casing back as the JSON keys instead of the
  schema's real camelCase keys ("identity", "offTable") — meaning every field from a real setup
  conversation was present in the DB but invisible everywhere it's read (prompt assembly, Lore UI edit
  form both look up by exact key). Confirmed by manually inspecting the raw SQLite row after a live
  conversation claimed an entry was "locked in." Fixed two ways: the tool description now shows both the
  real key and the label, and `normalizeFields` (case-insensitive match against key or label) backstops
  whatever casing the model actually sends, reporting unrecognized fields back to it as a tool-result
  warning instead of silently dropping them.

Also surfaced, not yet fixed: the same test conversation had the Editor's chat text claim an entry was
"locked in" without an accompanying tool call for it (register and the PC entry both went unpersisted
this way in one run). Optional/judgment-call tool use can't be forced-and-retried like compress/archive's
tool calls are — the doc's own design already anticipates this risk via the live worldbook preview
panel (built as part of this milestone): the human sees the real DB state next to the chat and can
manually create/fix an entry through the existing Lore UI if the Editor's words and the worldbook
disagree. The system prompt now explicitly tells the model not to claim an entry is saved unless it's
calling the tool in that same turn, which should reduce (not eliminate) how often this happens.

Deliberately not implemented: archiving the setup sequence and kickoff post as their own blocks (doc
steps 6-7 of Kickoff). Setup pages are hidden on approve and compression is queued for them (steps 4-5),
but the moment a page is hidden it's excluded from `assembleAuthorPrompt` entirely — those two archive
blocks would only ever serve a future Logs/Debug UI (Milestone E) that doesn't exist yet, and building
them now would mean either a synchronous wait on compression to finish inside the approve request or a
new state-based trigger with non-standard window boundaries. Trimmed as low-value-right-now, not
overlooked — see `src/services/kickoff.ts`.

**→ Vertical Slice reached.** A user can start a story, build a worldbook by talking to the Editor
(with tool calls landing correctly and a live preview to catch it when they don't), kick off, and play
turns where tags/compression/archiving demonstrably shape what the model actually sees — all confirmed
against a real multi-turn noir-detective test story, not just unit-level checks.

## Path to Phase 1 Complete

**D. Post controls + branching** — ✅ done, verified end-to-end 2026-07-01 against the noir test story:
edit, retry (plain + guided), continue (plain + guided), undo/redo/rewind, and fork all confirmed against
real data, including the actual "rewind then submit new content creates a non-destructive sibling
fork" behavior the doc describes, and a real physical-copy fork that plays independently of its source.

The load-bearing change underneath all of it: `findHeadPageId`/`listChronologicalPages` (`page-store.ts`)
used to find the tip by "structurally no children" — correct only when a chain never forks. Rewritten to
walk forward from the root via `selected_fork_page_id`, which is fork-aware (a page can have several
children once a rewind-and-continue creates a sibling; `selected_fork_page_id` says which one is
active). `createPage` now auto-sets its parent's `selected_fork_page_id` to itself, which is what keeps
every existing non-branching story working identically with zero extra calls anywhere.

Caught by direct testing before it shipped, not after: every page created before this refactor has
`selected_fork_page_id` sitting at NULL (the column existed since the original schema design but nothing
ever wrote to it) — the new forward-walk would have stopped at the root of every existing story instantly.
Added `backfillSelectedForks` (a one-time idempotent migration run on every story DB open) that infers the
correct forward pointer for any page with exactly one child, which is 100% of pre-existing data. True
leaves (no children) correctly stay NULL, which is exactly what makes them resolve as the head.

New concept: `story_state.current_page_id` — the Undo/Redo/Rewind cursor. NULL means "at the head,"
resolved dynamically; non-null means the user stepped backward and new posts should attach there instead
of at the true tip. `/:id/messages` and `/:id/continue` both attach at this resolved position (not
always the head) and reset it to NULL afterward. Also added `story_state.current_page_id` via an
idempotent `ALTER TABLE` migration (`ensureColumn` in `story-db.ts`) for the same "already-existing DBs"
reason as the backfill above — no migration framework exists yet, so this is the lightweight stand-in.

Fork (`src/services/fork.ts`) physically copies the story's SQLite file (WAL-checkpointed first so the
copy is complete), then in the copy hides everything after the fork point and severs that page's forward
pointer — a permanent structural truncation, not just moving the ephemeral cursor, since a separate story
file has no "redo forward" concept to preserve. Worldbook state is copied at its _current_ (latest) state
rather than reconstructed as of the fork point's timestamp — worldbook entries aren't chronologically
linked to log pages the way posts are, so true point-in-time reconstruction is a real feature in its own
right (adjacent to the doc's own deferred "worldbook deltas" idea). Fine for forks made close to the
story's current state; flagged as a known simplification for forks made from far in the past.

Observed, not a bug: guided retry's "make it shorter" direction wasn't strongly honored by the model in
one real test — the guidance is a plain trailing system message (not forced tool-calling, which doesn't
fit open-ended prose generation), so this is the same "models don't always follow plain-text instructions
consistently" characteristic already documented for the Author elsewhere, not new or code-related.

**G's config-driven layout system was pulled forward ahead of E** (explicit call, 2026-07-01) — building
E's sections against a hardcoded nav first and retrofitting a config-driven layer after would mean
reworking every section. Built first, done: `layout_configs` (global DB, already existed unused in the
schema) + `src/services/layout.ts`'s `DEFAULT_LAYOUT_CONFIG` (sections + one level of tabs — deliberately
not a fully generic recursive component tree, since Phase 1 doesn't render anything that needs deeper
nesting) + `GET`/`PATCH /api/layout`. Frontend `Nav.tsx` renders section/tab buttons purely from that
config and resolves each (section, tab) pair to a component via `registry.tsx`'s lookup table — which
section/tab exists is data now, not a hardcoded branch. Editing the config is a direct JSON textarea in
Settings (Phase 1 is explicitly read-only / no drag-and-drop per the doc, so this satisfies "configuration
-file-level task" without needing a visual editor).

**E. Full UI structure** — sections built as functional-equivalent chrome, not full doc fidelity
(explicit scope call, 2026-07-01): plain tabs/buttons exposing the same functionality, not the doc's
status-icon / half-transparent-sidebar / touch-first interaction design. That bespoke pattern is deferred
until there's a concrete reason to invest in it — the config-driven nav underneath doesn't care what
chrome sits on top of it later.

Done: Story section (Play = the existing phase-aware chat, now `StoryPlayPanel.tsx`; Saves = list/switch
/rename/create stories, shows fork lineage; Logs = per-post telemetry table, now backed by _real_ data —
`fillTextGeneration` didn't capture any metrics before this pass, so Logs would have shown nothing;
added `elapsedMs`/`tokenEstimate` capture in `executeProseJob` and extended `buildLogView`/`LogEntry`
with `createdAt`/`genMetrics`). Lore section (Worldbook = existing `LoreView`; Memory = the prompt
inspector). Config section (Agents = model/param editor, backed by a real `agent_configs` override table
— `authorProfile`/`workerProfile`/`editorProfile` were static exports read directly by every call site;
renamed to `DEFAULT_*` and replaced every call site with `getAgentProfile(role)`, which checks the DB
override first; Preview = the same prompt-inspector component as Lore > Memory, per the doc's own framing
of them as the same view in different contexts). Debug section (live job table + concurrency slot usage,
polled every 2s, scoped to the current story). Settings (layout JSON editor only so far).

Not done: the input bar "weapon wheel" (length/mood/param/model/effort toggles) — genuinely not started.
Config > Prompts is an honest stub, not a fake editor — there's no "core prompt" yet for the Author (see
Milestone A/B notes), so there's nothing to expose per-user overrides for. Settings has no UI-preference
controls (dark/light, font size, etc.) or preference-profile CRUD yet, only the layout editor. Logs
telemetry only covers prose (story) posts, not compress/archive job metrics. Debug is scoped to whichever
story is currently active, not a cross-story view.

**F. Security** — partially done, 2026-07-02.

- ~~Session tokens with single-active-session eviction (explicit signal on evict, not silent failure).~~
  — done, but decoupled from the password-login step this bullet originally assumed: a manual "claim"
  button triggers eviction instead. `src/db/session-store.ts` (built on the previously-100%-dead
  `sessions` table), `src/middleware/session-guard.ts` (global Hono middleware, 409 on any mismatch —
  applies to _all_ HTTP access, curl/dev scripts included, no bypass), `POST /api/sessions/claim`,
  frontend `ClaimGate.tsx` gating all of `App.tsx`. This is concurrency/data-integrity arbitration
  between one trusted user's own devices, **not access control** — the API still takes zero credentials,
  exactly as before. Verified end-to-end live: unclaimed → 409, claim → 200, second claim evicts the
  first with both sessions' real last-seen timestamps returned, a job started by a session evicted mid-
  flight ran to completion and produced a real reply, background polls confirmed _not_ to refresh a
  session's last-seen time (only real interactions do). Known accepted gap: direct in-process DB/script
  access (ad hoc `.mts` test scripts, the MCP dev-server tools) never touches Hono, so it bypasses this
  entirely — mitigated by habit (claim a throwaway session after such work if the browser should notice),
  not code, since closing it fully would mean hooking every mutating DB-store call.
- Real auth: password-derived key (PBKDF2 or similar), replacing the current pre-auth default-user
  placeholder. **Still not started** — deliberately deferred, not a blocker.
- Encryption at rest for story content and user metadata. **Still not started** — deliberately deferred,
  not a blocker.

**G. Remaining Phase 1 requirements** — ✅ done, 2026-07-01.

- ~~Config-driven layout system~~ — done, pulled forward ahead of E (see above).
- **MCP dev server** — `src/mcp/dev-server.ts`, a stdio MCP server (registered in `.mcp.json`, run via
  `npm run mcp`) exposing `list_stories`, `get_worldbook`, `get_tags` (with live matched-post counts),
  `get_queue_status` (jobs + slot usage), `get_recent_log`, and `tail_dev_server_log` — all reading the
  same SQLite files the main HTTP server does, directly, rather than round-tripping through HTTP (this
  is meant to work whether or not the dev server happens to be running). Verified end-to-end with a real
  MCP client connection over stdio, not just a typecheck — every tool called and its output checked.
- **Ranked-choice model fallback** — `FeatherlessError` (carries HTTP status) + `withModelFallback` in
  `src/inference/featherless.ts`; `AgentProfile.fallbackModels` (ranked, editable via Config > Agents)
  tried in order when the primary returns a "this model is unavailable" status. Verified with a real
  failure: set the worker's model to a string that doesn't exist, confirmed the job failed with a
  Featherless 404, added a fallback model, confirmed the _same_ job type then succeeded via the
  fallback. That test surfaced a real gap — 404 (`model_not_found`) isn't in Featherless's documented
  error table at all, and wasn't in the original unavailable-status set (400/403/503); added it. See
  docs/featherless-notes.md.
- **Provider boundary** — confirmed clean, and tightened while confirming: `FEATHERLESS_API_KEY`/
  `FEATHERLESS_BASE_URL`/`FEATHERLESS_USER_AGENT` lived in the shared `config.ts` alongside the
  provider-agnostic `AgentProfile`/`DEFAULT_*_PROFILE` — moved to a new `src/inference/featherless-
config.ts` so `config.ts` has zero Featherless-specific symbols left. Confirmed via grep that nothing
  outside `src/inference/` touches raw Featherless request/response shapes — everything else calls
  `streamInference`/`callWithForcedTool`/`callWithTools`/`withModelFallback` with a provider-agnostic
  `AgentProfile` + `ChatMessage[]`.

**Additional, post-Phase-1: Toast notifications + client error logging** — ✅ done, 2026-07-02.
Not part of loremaster.md's original scope; added because frontend errors were otherwise invisible
unless DevTools happened to be open. `web/src/toast.ts` (module-level pub-sub store, same idiom as the
existing `onSuperseded` channel) + `web/src/ToastHost.tsx` (fixed bottom-right stack, mounted once in
`main.tsx` alongside `App`, not gated by it) + `web/src/error-capture.ts` (monkey-patches
`console.error`, listens for `window.onerror`/`unhandledrejection`). Only `critical` toasts are sticky
until dismissed; `info`/`warning`/`error` auto-fade on a severity-scaled timer. Every
`warning`/`error`/`critical` toast also fire-and-forget POSTs to a new `POST /api/client-errors`
(`src/routes/client-errors.ts` + `src/db/client-error-store.ts`, backed by a new `client_errors` table
in the global schema) for later analysis — deliberately a plain `fetch`, not the shared `apiFetch`, so a
failed log-POST can never cascade into another toast/log attempt.

Found and closed a real gap during design: none of the existing per-view `catch` blocks actually called
`console.error` (they only set local state for the inline `error-banner`), so the monkey-patch alone
would have silently missed all of today's existing error handling. Added one `console.error(err)` line
to each of the ~29 catch sites across 9 view files. `apiFetch` (`web/src/api.ts`) now also wraps its
`fetch()` call and treats a network failure or `5xx` as a `console.error`, which `error-capture.ts`
recognizes as a network-failure signature and escalates to a sticky critical toast — directly matching
the original "site stopped responding, CORS error" complaint that prompted this feature.

Verified live: `console.error("test")` produces a fading error toast; a _real_ uncaught exception
(`setTimeout(() => { throw new Error(...) })`, not a directly-typed `throw` — Chrome's DevTools console
REPL swallows synchronous throws before they reach `window.onerror`, a browser quirk not a bug here)
produces a sticky critical toast; the backend-down path was confirmed via `apiFetch`'s network-failure
branch; `POST`/`GET /api/client-errors` round-tripped a real row via curl, and the session guard rejects
it with no bypass like every other route. Deliberately deferred: building friendly-title explanations
(e.g. "CORS (backend inaccessible)" for a raw `Failed to fetch`) — there's no real accumulated data yet
to base them on; revisit via `GET /api/client-errors` after some real usage.

**→ Phase 1 Complete here**, per loremaster.md's explicit scope, **modulo Milestone F (Security)'s
remaining real-auth and encryption-at-rest bullets**, deliberately deferred per explicit instruction —
the single-active-session-eviction bullet is done. Future Phases appendix items (additional providers,
WYSIWYG layout editing, worldbook deltas, pronoun-per-tag declarations, outside MCP client support)
stay out of scope unless explicitly requested.

## Disambiguation resolution (2026-07-12) — ✅ done

Full execution of `docs/disambiguation-resolution.md`: ~46 items across 6 phases eliminating naming collisions, overloads, and orphaned references across the codebase.

**Phase 1 — Purge Dead Code:** Deleted `archive-worker.ts`, `compress-worker.ts`, `compression.ts`, `memory-config.ts`, `src/experiments/`. Removed `gen_extract` column (text-store, schema, log-view), `compress` job type, `sourcebook` book type. Cleaned `COMPRESSION_ENABLED` imports, simplified `postNeedsCompress` to stub.

**Phase 2 — Backend Renames (12 files):** `memory-manifest.ts` → `context-manifest.ts`, `memory-invalidation.ts` → `context-invalidation.ts`, `content-stamp.ts` → `content-fingerprint.ts`, `play-tab.ts` → `display-preferences.ts`, `toggle-presets.ts` → `generation-presets.ts`, `worker-lanes.ts` → `job-lanes.ts`, `story-to-date-corpus.ts` → `story-to-date-engine.ts`, `kickoff.ts` → `story-transition.ts`, `worldbook-pc.ts` → `worldbook-assembly.ts`, `api-coordinator.ts` → `api-limiter.ts`, `outbound-log.ts` → `outbound-telemetry.ts`. Merged `story-to-date-admin.ts` into `story-to-date.ts`.

**Phase 3 — Content Changes:** Deduplicated `AgentRole` to `model-config-store.ts`. Renamed `StoryPhase 'story'` → `'active'`, `book_type 'game'` → `'story'`, `memory_content_stamp` → `content_hash`. Renamed `/memory` → `/context` routes. Renamed `archive-name` → `segment-name` job type. Removed legacy archive system (`archive-store.ts`, `archive.ts`, `archive-eligibility.ts`, `archive-view.ts`, `purgeLegacyArchives`, archive tables from schema).

**Phase 4 — File Moves:** Moved `global-css.ts` → `src/defaults/`, `db/time.ts` → `src/lib/time.ts`, `horde-slots.ts` → `src/inference/`. Consolidated `corrupted-tools/` to root.

**Phase 5 — Frontend Renames (8 components):** PascalCase renames (`playTabSettings.tsx` → `PlayTabSettings.tsx`, etc.), view renames (`SettingsView` → `PreferencesView`, `ArchivesView` → `SegmentsView`, `MemoryView` → `ContextView`), registry tab keys updated.

**Phase 6 — Verification:** 72/72 tests passing, 0 lint warnings (backend), 0 compilation errors, 12 pre-existing frontend lint warnings preserved.

13 diagnostic scripts updated for renamed modules/paths. 3 dead scripts deleted (`check-memory-jobs.ts`, `story-memory-stats.ts`, `test-memory-invalidation.ts`).

**Additional, post-Phase-1: centralized prompts, freeform worldbook, pure-grep tags** — ✅ done,
2026-07-03. Replaces the forced-tool-calling worldbook extraction pipeline (Milestone C's
`runWorldbookExtraction`) with plain bracket-tagged prose the back end regex-scans deterministically —
see docs/stub-revisions.md's superseded entry for why the old mechanism was dropped, and
loremaster.md's Structured Schema section for the new one. Summary of what changed:

- `src/prompts.ts` centralizes all 9 prompt constants (previously scattered/duplicated across
  `history.ts`, the now-deleted `setup.ts`, and `pipeline-runner.ts`), sourced verbatim from a
  `prompts.md` the user wrote (deleted once `src/prompts.ts` was confirmed working, to kill the
  duplication-drift risk).
- Worldbook entries collapsed from six typed schemas (Setting/Register/Location/Creature/Faction/
  Character) with structured fields to three freeform types (CONTENT/ROSTER/MEMORY), each a single
  content string with no name/fields/singleton enforcement. CONTENT accumulates (not a singleton) and
  is always injected in creation order; ROSTER/MEMORY are tag-triggered like before.
- `src/services/worldbook-extraction.ts` (backend) + `web/src/worldbookBlocks.ts` (frontend, no shared
  module path between the two TS projects so this is a deliberately duplicated sibling copy) detect
  `[CONTENT]`/`[ROSTER]`/`[MEMORY]` bracket pairs via a backreferenced regex — mismatched tags never
  match, empty result is not an error, content is stored verbatim.
- Tags dropped their manual `worldbookPageId` pointer entirely — matching is pure grep via the
  existing `tag_index` infrastructure (already spanned both logbook and worldbook content as siblings
  under the "game" book), now also wired to fire on worldbook entry create/update, closing a real gap
  where only post creation triggered re-indexing before. Tag validation tightened to
  `/^[A-Za-z]{3,}$/` (3-character floor added).
- Pre-kickoff setup turns stayed dual-pass (conversational reply + a separate `setup-worldbook` job
  authoring pass, matching `EDITOR_SETUP_PROMPT` + `EDITOR_SETUP_WORLDBOOK` being distinct prompts);
  post-kickoff OOC "update sessions" became single-pass (`EDITOR_UPDATE_PROMPT` embeds the bracket
  schema inline, so the one reply is scanned directly) — this asymmetry surfaced by re-reading
  prompts.md literally mid-implementation, confirmed with the user rather than assumed. Update
  sessions are session-scoped (`story_state.ooc_session_start_page_id`) but get the current IC log
  folded in as read-only reference context, reusing `assembleAuthorPrompt`'s existing tiered assembly
  rather than a second history system.
- Migration: `worldbook_entry`'s old shape is dropped and recreated on next `getStoryDb()` open (dev-only
  codebase, no migration framework, explicit no-data-preservation choice) — detected via checking
  `sqlite_master.sql` for the old `'setting'` CHECK string.

Verified live end-to-end against the running dev server with real Featherless calls (not mocked):
migration ran clean against 2 pre-existing story DBs, tag validation rejected `"ab"`/`"a1b"` and
accepted `"gareth"`, bidirectional tag↔entry indexing confirmed both orders, a real dual-pass setup
turn produced 1 CONTENT + 2 ROSTER + 1 MEMORY entry from one model response, kickoff correctly pulled
CONTENT entries in, tag-triggered ROSTER/MEMORY injection confirmed via `/prompt-preview`, and an
update-session turn ("bring me up to date") showed genuine IC awareness with exactly one job created
(single-pass confirmed).

**Additional, post-Phase-1: reconnect-safe streaming + live "Thinking…" indicator** — ✅ done,
2026-07-03. Two gaps found in real use: closing the story tab mid-generation and reopening it left the
post frozen as a literal "…" until some unrelated action happened to call `refresh()` (pendingReplies
is plain component state, wiped on remount, and nothing re-subscribed to the still-running job); and
the pre-first-token gap showed a dead "…" with no signal at all.

- `job-events.ts` now buffers each job's accumulated text/progress in memory (cleared on
  done/error). A fresh SSE connection — including a genuinely new one after remount, not just
  EventSource's own auto-reconnect — gets a `sync` event replaying everything generated so far before
  continuing with live `token` events. Verified live: a second connection opened mid-generation
  received the exact accumulated text the first listener had, byte-for-byte.
- New `GET /:id/jobs/active` (registered before the `:jobId` route to avoid the param route
  swallowing the literal path "active") lets a remounted `StoryView` find any log entry still
  mid-generation (`content === null`, agent role) and reattach `watchJob` to its job — confined to
  mount/story-switch only, not every `refresh()` call, since in-session action handlers already call
  `watchJob` themselves and pendingReplies' state closure wouldn't reflect that yet at the point a
  general `refresh()`-triggered recovery pass would run, which would otherwise double-subscribe.
- Confirmed there's genuinely no more granular signal available before the first token — Featherless
  gives nothing between "request sent" and "first token," and the existing `publishProgress` narration
  mechanism has never actually been wired up anywhere. Replaced the static "…" with a ticking
  `Thinking… (Ns)` counter (elapsed since the job was created), only running the interval while
  something is actually in that dead zone.

**Additional, post-Phase-1: reasoning trace, prefill labels, server-anchored timers** — ✅ done,
2026-07-04 (raw-stream probe corrected same day). Empirical capture:
`scripts/probe-deepseek-raw.ts` → `data/experiments/deepseek-raw/*.jsonl`;
`scripts/summarize-raw-stream.ts` for neutral delta-key stats.

With production assistant prefill, Featherless `deepseek-ai/DeepSeek-V4-Pro` emits **`delta.reasoning`**
chunks first (~8s in one run), then **`delta.content`** for IC prose — not `reasoning_content`, and
no XML thinking tags in the stream. Parser in `featherless.ts` forwards both `delta.reasoning` and
`reasoning_content` to SSE `thinking` events. Story tab phases: queue/memory → **Prefilling… (~Ns)**
→ **Reasoning trace** (streaming) → IC prose (trace collapses). Timers anchor to server job timestamps.
An early tag-splitter mistake (`startsInThinking` from prefill alone) briefly misrouted prose into the
trace; fixed in `reasoning-stream.ts` the same day.

**Additional, post-Phase-1: Effort-aware thinking stream + false-retry fix** — ✅ done, 2026-07-04.
Probe matrix and production results: [docs/reasoning-stream-research.md](reasoning-stream-research.md).
`enable_thinking: false` with assistant prefill caused Featherless to emit IC prose only on
`delta.reasoning`, which tripped “reasoning but no answer content” retries and stacked drafts in the
trace (trace reset shipped in `21d33d7`; root cause fixed same day). `proseStreamUsesReasoningTrace` /
`shouldPrefillReasoning` gate prefill, trace UI, idle timeout, and reasoning→prose routing on Effort
Off vs On. Horde prose path unchanged (no reasoning-channel handling). Horde smoke test re-run after
changes: OK.

**Additional, post-Phase-1: silent OOC session boundary + Story tab mode persistence** — ✅ done,
2026-07-03. The post-kickoff OOC "update session" boundary (`ooc_session_start_page_id`) used to be
set by dropping a canned `EDITOR_UPDATE_OPENING` "Welcome back" message as a real hidden page every
time the user toggled Play→OOC — jarring on its own, and repeated toggling stacked up multiple copies
in the log. `POST /:id/ooc/start-session` no longer creates a page or writes anything to the log; it
just moves the boundary to whichever hidden page is already most recent, so the Editor's context still
resets per session with nothing new visible and no cost to toggling back and forth. `EDITOR_UPDATE_OPENING`
removed from `src/prompts.ts` and the prompt catalog entirely — no replacement needed.

- Separately, closing and reopening the Story tab (Nav's tab columns fully unmount a panel on close)
  reset IC/OOC mode back to its phase-based default, which combined with the above meant reopening
  into OOC re-triggered a session boundary move mid-conversation, truncating the Editor's context out
  from under an in-progress design chat. `StoryView.tsx` now persists `mode` to `localStorage` keyed by
  story id and restores it on mount — the toggle button's own handler is still the only thing that ever
  calls `startOocSession`, so restoring a persisted "guide" mode on remount is a pure client-side no-op.

**Additional, post-Phase-1: Logs/Worldbook collapsed-by-default content, Preview tab retired for a new Summary tab** —
✅ done, 2026-07-03.

- Logs and Worldbook both showed full post/entry content inline at all times, which got noisy fast.
  Both now default to collapsed: Logs shows a truncated single-line preview per row (click to
  expand/collapse in place, full pre-wrap text when open) instead of a dedicated content column;
  Worldbook's entry cards collapse to just the header (entry type + truncated preview + caret) until
  clicked, with `EntryContent` (and its `.entry-card-content`) only rendered while expanded.
- Config > Preview (the assembled-prompt inspector) was an intentional duplicate of Lore > Memory from
  Phase 1 (see the "reused prompt-inspector component" note earlier in this doc) that never earned its
  keep as a second surface — retired. `PromptInspectorView.tsx` deleted; its shared `.prompt-message`
  CSS survives as `PromptMessage.css`, now imported directly by `MemoryView.tsx`.
- New Story > Summary tab (`SummaryView.tsx`) — **legacy:** showed `gen_extract` per post; compression
  retired 2026-07-04. Candidate for removal. Archives tab now manages story-to-date segments.
- `DEFAULT_LAYOUT_CONFIG` (`src/services/layout.ts`) updated to match (Preview removed, Summary added
  after Logs). Since a layout config had already been persisted to `data/global.sqlite` from an earlier
  session (the active row wins over the code default — see `GET /api/layout`), that row was updated
  directly to match; a fresh install would pick up the new default with no such step needed.

## Notes on sequencing

This is a suggested order, not a fixed contract — A→B→C is chosen because it finishes what's already
half-built (prompt assembly) before opening new surface area (worldbook/Editor), and D→E→F→G groups
naturally-independent chunks of the remaining Phase 1 scope. Reorder freely; nothing here blocks
anything else except A blocking B (worldbook injection needs real prompt assembly to inject into).

## Horde as a second provider — ✅ done, 2026-07-03

Originally scoped in loremaster.md as one combined "Multi-User & Second Provider Milestone." Split
apart 2026-07-03 — the doc itself frames these as two independent problems that only incidentally got
scoped together, and proving Horde out against the existing single default user is lower-risk than
building auth + per-user isolation + a second provider all at once. Multi-user work (login, per-user
file isolation, per-user encrypted keys) moves to a **Phase 2 backlog**, captured at the end of this
section — not dropped, just resequenced after this proves out.

Two real discrepancies surfaced while re-grounding the plan against current code (2026-07-03), worth
remembering when Phase 2 is picked up:

- "File-level per-user isolation" has no existing pattern to build from. `data/global.sqlite` is one
  shared file for every user's `layout_configs`/`settings_spaces`/`preference_profiles`/`model_configs`/
  `stories`/`sessions`, scoped only by a `user_id` column. Only story _content_ is file-per-unit today —
  per-story isolation is precedent for the idea, not reusable code.
- There is no login in any form today. `session-guard.ts` hardcodes `getOrCreateDefaultUser()`; the
  existing "claim" flow (Milestone F) is a single global claim, not per-user auth. Real login is net-new
  work, not a generalization of session-claim.

Also resolved: whether `global.sqlite`'s shared-file design needs to change for write-contention
reasons before Phase 2. It doesn't — `journal_mode = WAL` already keeps readers and writers from
blocking each other, and since better-sqlite3 is synchronous inside one Node process, there's no real
concurrent-writer scenario from HTTP traffic in the first place; every query already serializes on the
event loop. The contention rationale in loremaster.md's Security section doesn't bite until write
throughput far beyond what <10 trusted users produce. The durable reason to eventually split per-user
data into files is the "encrypt one user's data as a unit" future goal, not contention.

**Superseded (2026-07-03, later same day):** the "Featherless stays single shared" decision above
was reversed once real multi-user login existed. Each user now stores their own Featherless and
Horde key, encrypted at rest (`users.featherless_key_encrypted`/`horde_key_encrypted`, AES-256-GCM
via `src/crypto.ts`, keyed off a single `APP_MASTER_KEY` env secret), managed from the Agents tab
(`ApiKeysSection.tsx`) via `/api/account/{featherless,horde}-key`. `concurrency-feed.ts` and
`slots.ts` were both reworked to track concurrency per userId instead of one process-wide/global
counter, since each user now has their own independent account limit. `.env` no longer holds
either provider key — only `APP_MASTER_KEY` and the unrelated `DEV_BYPASS_SESSION_GUARD` dev
toggle remain.

**H1. Horde REST client (standalone, unwired)** — ✅ done.

- `src/inference/horde.ts` (mirrors `featherless.ts`'s shape): submit (`POST /v2/generate/text/async`),
  poll (`GET .../status/{id}`), cancel (`DELETE .../status/{id}`). Treats `is_possible: false`, `429`,
  and `faulted` as first-class outcomes, not exceptions to patch around later.
- `src/inference/horde-config.ts` (mirrors `featherless-config.ts`): originally a plain
  `HORDE_API_KEY` env var by explicit decision (2026-07-03); superseded later the same day — see the
  per-user key storage note above. `HORDE_ANONYMOUS_KEY` (`"0000000000"`) remains the fallback
  whenever a user hasn't set their own Horde key.
- No maintained Node/TS SDK exists for Horde text generation (the one npm package covers image gen
  only) — hand-rolled against the public swagger schema, same as Featherless.
- **Answers the open tool-calling question first, deliberately sequenced before anything depends on
  it**: does Horde's actual worker pool support forced tool-calling reliably enough for the Worker role
  (compress/archive)? Verify with a real forced-tool-call request, not just by reading the schema.
- Confirmable as: a script gets a real completion back via the anonymous key, and a second run gives a
  definitive yes/no on tool-calling.

**H2. Provider field on model configs** — ✅ done.

- `model_configs` gets `provider TEXT NOT NULL DEFAULT 'featherless'` (via `ensureColumn`, same pattern
  as the existing `fallback_models` column); `AgentProfile` (`src/config.ts`) gets a matching `provider`
  field.
- `src/services/agent-config.ts`'s `getAgentProfile(role)` returns it — no `userId` param needed yet,
  still the default user.
- Pure provider-abstraction plumbing; the field Phase 2's per-user access filtering will eventually key
  off, but it does nothing user-specific yet.
- Confirmable as: existing Featherless-backed configs keep working unchanged (default value); a
  manually-inserted `provider = 'horde'` row round-trips through the existing list/get functions.

**H3. Horde queue/dispatch integration** — ✅ done.

- `pipeline-runner.ts`'s `scanStory` branches on `provider`: Featherless keeps its current
  synchronous-await path untouched. Horde jobs submit-then-return, storing the Horde-side request id on
  the job row (new nullable column on `jobs` in `story-schema.ts`, same `ensureColumn` pattern), polled
  (piggybacking the existing scan tick, or a slower dedicated one — Horde jobs can sit for minutes)
  until finished/faulted before filling the text.
- Horde jobs skip `tryAcquireSlot`/`releaseSlot` entirely (Featherless-specific, untouched) — no
  account-wide signal exists to gate against, so this needs its own much simpler local cap on
  outstanding submissions.
- No streaming: `job-events.ts`/the SSE consumer needs "single done event, no partial tokens" to read
  as a normal Horde-job shape, not a stall.
- Confirmable as: a Horde-routed prose job round-trips through the real queue end-to-end into the
  story, running alongside a Featherless-backed job without either blocking the other.

**H4. Config UI wiring** — ✅ done.

- Config > Agents' per-row model config gets a provider selector; Horde rows use the Horde's
  `models`/`workers` targeting fields instead of Featherless's model catalog.
- If H1 found Horde tool-calling unreliable, add a guardrail against assigning Horde to the Worker role
  specifically — Author/Editor are fine either way.
- Confirmable as: a Horde-backed model config can be created from the UI, assigned to a role, and
  actually used.

**H5. End-to-end validation** — ✅ done.

- One full story turn generated via Horde start to finish through the real UI: no-streaming UX reads as
  intended (not a hang), Debug/Logs show Horde jobs sensibly, nothing in the existing Featherless path
  regresses.
- Real-browser testing (2026-07-03) also caught and fixed four bugs outside the Horde work itself:
  reorder skipping draft messages, Horde jobs mislabeled with the wrong model, no confirm on worldbook
  entry delete, and `apiFetch` treating all `409`s as session-superseded instead of surfacing real
  conflicts. See `88abe43`.

**Additional: build-info header (deploy verification)** — ✅ done, 2026-07-05. Debugging a scroll fix
on the live VM burned a round trip on "is this actually the new build, or a cached one?" — the header
now shows the running build's git commit hash (hover for the exact build timestamp), stamped at
`vite build` time via `web/vite.config.ts`'s `define: { __BUILD_INFO__ }`, rendered in `App.tsx`. See
[gcp-deployment.md](gcp-deployment.md)'s "Confirming a deploy actually landed" note. Worth checking
first any time live behavior doesn't match what was just deployed, before assuming the fix is wrong.

## Phase 2 backlog: Multi-User

Deferred 2026-07-03 so Horde integration can prove out against the existing single-default-user model
first. Not designed in detail yet; captured here so the earlier planning pass isn't lost.

- **Real per-user login — done 2026-07-03.** Netflix-style profile picker (`GET /api/users` — id +
  display_name only) feeding a password-gated claim (`POST /api/sessions/claim` now takes
  `{userId, password}`, verified via `bcryptjs.compareSync` against `password_verifier`).
  `session-guard.ts` resolves session → real user rather than assuming a single default user;
  `createSession`'s existing per-`user_id` eviction meant true simultaneous multi-user login needed no
  new mechanism, just real distinct identities threaded through it. `DEV_BYPASS_SESSION_GUARD` is now
  `false` by default. Admin-provisioned accounts only (`npm run user:create -- <name> <password>`), no
  self-serve signup. Also closed a gap found during scoping: story-scoped routes had no ownership
  check at all — added a shared `requireStoryOwnership` middleware (403 on mismatch) covering every
  `/api/stories/:id...` route. Per-user file isolation remains deferred below, as originally scoped.
  Per-user encrypted Featherless/Horde key storage is **done** (Agents tab + `users.*_key_encrypted`).
- **Per-user file-level data isolation.** `data/global.sqlite`'s `layout_configs`/`settings_spaces`/
  `preference_profiles`/`model_configs`/`stories` split into one file per user (new
  `src/db/user-db.ts`/`user-schema.ts`, mirroring `story-db.ts`'s pattern), leaving `global.sqlite` down
  to just `users` + `client_errors`. `sessions` stays global regardless — a session token is exactly
  what tells you which per-user file to open, so it can't live behind that boundary itself. Not
  motivated by write contention (confirmed a non-issue at this project's scale, see above) — motivated
  by the "encrypt one user's data as a unit" goal, so revisit once that's actually being built.
- **Per-user encrypted API key storage** — done 2026-07-03 (Featherless + Horde, Agents tab). No
  `featherless_access` flag — each user brings their own Featherless key; nothing shared globally.

---

## Post-Phase-1 incremental work (2026-07-05+)

After Phase 1 Complete, work shifted to hardening and polish — story-to-date memory quality,
performance, and UX edge cases surfaced by real VM sessions.

### Story-to-date memory hardening — ✅ done, 2026-07-05+

- **Fold / batch sizing** (`e6e3ef8`, `85c78d1`): continues segments that would overflow Editor output
  are now batched and recursively folded so they fit. Fold jobs are cancellable and visible in Debug.
- **Scene scoping** (`f8c648f`, `d3ebb54`): continues scoped to one scene per block; blocks that
  sprint coverage past one scene are rejected with a step-back retry. Coverage ceiling tightened.
- **Seam quality** (`36f0b1f`, `acc02b4`): leaked story markers (`[STORY BEGINS]` etc.) stripped from
  memory blocks at parse and assembly layers. Paragraph breaks preserved in Archives display.
- **Reseed script** (`951466f`, `959ca2f`): one-shot `scripts/reseed-story-to-date.ts` backfills
  story-to-date segments for existing stories, matching production Editor timeout.

### Worldbook crunch — ✅ done, 2026-07-05+

- **Manual crunch** (`43224dd`): "Crunch worldbook" button on-demand compacts worldbook entries via
  Editor pass, reducing token bloat from accumulated CONTENT deltas.
- **Queued crunch** (`275fc86`): crunch runs as a `worldbook-compact` job so it appears in Logs and
  Debug alongside other background work.
- **Crunch fixes** (`46bc565`, `90e94a7`): prefix leak from crunch output fixed; duplicate bracket
  tags from crunch output caught and stripped. Per-entry job summary added.

### Performance — ✅ done, 2026-07-05+

- **Story log pagination** (`c52601d`): story log paginated instead of loading full history on every
  refresh — significant reduction in DB load for long stories.
- **Outbound log caching** (`bbfb9b4`): outbound request log no longer re-read from disk on every
  inference call.
- **Tab blocking reduction** (`7dad48d`): fetch coordinator (`web/src/api-coordinator.ts`) bounds
  polling frequency; bounded polls and read cache prevent tab-switch stalls.
- **Debug tab split** (`2966fdb`): Queue and Logs split into separate Debug tabs to avoid loading
  both at once on section open.

### Streaming & UX — ✅ done, 2026-07-05+

- **Partial stream commit on stop** (`4021006`): stopping mid-generation now commits whatever partial
  content has arrived, instead of discarding it.
- **Reasoning-channel filtering** (`6360e6e`): leaked reasoning-channel artifacts (XML thinking tags
  in content stream) rejected instead of shown or stored.
- **Craft vocabulary prompts** (`bb95b83`): vague prose direction replaced with specific craft-
  vocabulary terms from a systematic log audit — see `docs/prose-craft-vocabulary-cheat-sheet.md`.

### Code quality tooling — ✅ done, 2026-07-12+

- **Prettier** (`.prettierrc`, `.prettierignore`): `npm run format` in both root and `web/`. Run once
  across the codebase — all files already conforming. `lint-staged` + `simple-git-hooks` pre-commit
  hook auto-formats staged `*.{ts,tsx,js,jsx,json,css,md}` files.
- **Lint:** oxlint configured for both packages (`npm run lint`). Backend clean (0 warnings as of
  2026-07-12); frontend has 12 remaining warnings deferred for follow-up.
- **Testing:** vitest (`npm test`, `vitest run`) and playwright (`npm run test:e2e`) configured.
  Test directories: `tests/db/`, `tests/lib/`, `e2e/`.
- Documentation updated to reflect current state: loremaster.md (archives contradiction resolved,
  Provider Abstraction + Multi-User sections updated for shipped status), stack.md (formatter/test
  framework claims corrected, new commands added), frontend.md, README.md, dev-workflow.md.
