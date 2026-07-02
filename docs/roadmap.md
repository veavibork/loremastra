# Loremaster roadmap

Two checkpoints ahead: **Vertical Slice** (every core mechanism touched at least once, end-to-end, with
a minimal real UI) and **Phase 1 Complete** (everything loremaster.md scopes to Phase 1, excluding the
Future Phases appendix). Still building one step at a time — this exists so "push on to something else"
has a target, not so we jump ahead of confirming each step.

**Current status (2026-07-02): Vertical Slice reached. Milestones A-E and G done. Milestone F
(Security) is partially done** — single-active-session eviction is built and verified; real
password auth and encryption at rest remain deliberately deferred, not blockers. Everything below
this line reflects that state; see each milestone's own section for what "done" actually covers and
what's explicitly still missing within it.

## Done so far (proven, not full-featured)

- Two-tier SQLite storage (global DB + per-story files), book/page/text generic content schema.
- Job queue: durable job table, cost-based concurrency slots, timeouts, stale-job recovery on restart,
  handshake+poll+SSE client protocol (no more silent-hang class of bugs).
- Tags: mutable tag cloud, retroactive grep indexing (both directions — new content vs. existing tags).
- Compression: 5-turn-lag trigger, forced-tool-call worker summarization with validation+retry.
- Real Featherless integration: streaming author calls, forced tool-calling, model catalog + tag-rating
  scaffold for role-based model discovery.
- Minimal React UI: single story, post a message, watch it stream in.
- Archive tier + real tiered/tag-driven prompt assembly (`assembleAuthorPrompt`, steps 5-8 of the doc's
  algorithm) — verified end-to-end 2026-07-01: two overlapping 10-post archive blocks formed correctly,
  editor-generated narrative summaries, ownership computed and assigned correctly across overlapping blocks.
- Worldbook + Tags UI (Milestone B) — verified end-to-end 2026-07-01: `worldbook_entry` table keyed to
  `page.id` (reuses existing page/text versioning — edits are `createRetryText`, giving version history
  for free; singleton enforcement for Setting/Register/PC via partial unique indexes, not just app-layer
  discipline). `assembleAuthorPrompt` now implements the doc's steps 3-4 (always-include Register/Setting/
  PC, tag-triggered worldbook entries) and the tag-priority ordering rule for steps 7-8 (tags without a
  worldbook entry promoted before tags that already have one). Minimal Lore UI (tag cloud + worldbook
  list/edit, reachable via a Story/Lore tab) is live. Confirmed via direct prompt inspection: Setting/
  Register/PC always appear, and a tagged NPC entry (Halia) was correctly pulled into a real generation
  when the trigger post mentioned her.

Caught and fixed one real bug in the process: archive jobs were hardcoded to `slotCost: 1`, but the
editor uses the same large model as the author (cost 4 on the real Featherless account) — a live 429
surfaced it immediately when two archive jobs tried to run "concurrently" under our own (wrong) local
accounting. Fixed by hardcoding to 4 to match; the real fix (read `concurrency_cost` from the model
catalog instead of hardcoding per job type) is still open — see docs/featherless-notes.md.

Also fixed along the way: the CORS `Access-Control-Allow-Methods` header (both the global one in
`src/index.ts` and the one in `stories.ts`) was missing `PATCH`, which would have silently broken the
tags PATCH route's preflight from a real browser (curl doesn't preflight, so this went unnoticed until
now).

Not yet implemented: a "core prompt" (Author system prompt/identity) — the Author still has zero system
prompt at all, an explicit deferred decision from earlier in the session. Step 3's "core prompt" half is
still missing; only its register/setting/PC half is done.

Creature/Faction field shapes: loremaster.md doesn't spell out explicit "Fields:" lists for these two the
way it does for Location and Character. Pulled the actual field lists from lorepebble's `st1.json`
(Setup Assistant card) instead, per explicit instruction — Creature: identity, how they think, speech,
wants, disposition, do-not; Faction: identity, how they appear, stance toward the PC, leader.

## Path to Vertical Slice

**A. Archive tier + real prompt assembly** — ✅ done.

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
file has no "redo forward" concept to preserve. Worldbook state is copied at its *current* (latest) state
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
/rename/create stories, shows fork lineage; Logs = per-post telemetry table, now backed by *real* data —
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
  applies to *all* HTTP access, curl/dev scripts included, no bypass), `POST /api/sessions/claim`,
  frontend `ClaimGate.tsx` gating all of `App.tsx`. This is concurrency/data-integrity arbitration
  between one trusted user's own devices, **not access control** — the API still takes zero credentials,
  exactly as before. Verified end-to-end live: unclaimed → 409, claim → 200, second claim evicts the
  first with both sessions' real last-seen timestamps returned, a job started by a session evicted mid-
  flight ran to completion and produced a real reply, background polls confirmed *not* to refresh a
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
  Featherless 404, added a fallback model, confirmed the *same* job type then succeeded via the
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

Verified live: `console.error("test")` produces a fading error toast; a *real* uncaught exception
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

## Notes on sequencing

This is a suggested order, not a fixed contract — A→B→C is chosen because it finishes what's already
half-built (prompt assembly) before opening new surface area (worldbook/Editor), and D→E→F→G groups
naturally-independent chunks of the remaining Phase 1 scope. Reorder freely; nothing here blocks
anything else except A blocking B (worldbook injection needs real prompt assembly to inject into).
