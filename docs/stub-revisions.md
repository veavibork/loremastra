# Stub & revision tracker

Living list of things that are deliberately incomplete, stubbed, or flagged as needing a
second pass — as distinct from `roadmap.md`, which tracks milestone completion. An item
lands here when it's real but not final: a placeholder UI, a simplification with a known
gap, or a design question that needs more information (usually real play-testing) before
it can be resolved. Remove an item once it's actually resolved; don't let this become a
second roadmap.

## Prompts

- **Core Author prompt now exists and is wired in** (`AUTHOR_SYSTEM_PROMPT`,
  `src/services/history.ts`, 2026-07-01) — prepended in both `assembleAuthorPrompt` and
  `assembleKickoffPrompt`, verified live via `/prompt-preview` against real story data.
  Combines st2.json's GM skeleton with the user/player/character layering, yes-and/no-but
  contract, and but-therefore causal framing from Alex's improv notes.
- **Compress prompt now resolves pronouns to character names** (2026-07-02) — the tag
  system matches literal names via grep against `genPackage` for posts / `genExtract` for
  compressed lines, so a post like "I deck him" produced a compressed summary the tag
  index could never match against "Rook." `COMPRESS_SYSTEM_PROMPT` now explicitly asks for
  pronoun resolution, and the compress call is given a character-name roster pulled from
  the worldbook (originally `listWorldbookEntries` filtered to `entryType: "character"`)
  plus the existing one-post prior-summary context to resolve who's meant. Verified live: given
  prior context "Rook corners Vale by the punch bowl..." and post "I deck him", the
  compressed summary correctly came back "Rook is punched by Vale" — both the PC's "I" and
  the pronoun "him" grounded to real names. This is a different fix from the declined
  "pronoun declarations per tag" idea below — that was about matching tags *on* pronouns;
  this is about the Author/compress pipeline never emitting an unresolvable pronoun into
  text the tag system reads in the first place.
  **Known gap opened 2026-07-03:** the worldbook refactor (see this file's superseded
  extraction entry above) dropped the `character` entry type — there's no structured "NPC
  name" field to pull a roster from anymore. Compress context now uses `listContentEntries`
  (CONTENT-type entries — setting/premise material, which usually includes the PC's name)
  instead, which doesn't cover NPC names living in ROSTER entries. Flagged, not yet fixed —
  revisit by also passing tag-triggered ROSTER/MEMORY entries into compress context if
  pronoun-resolution quality regresses in real use.
- **Compress prompt now gets one post of prior context** (2026-07-01) — threads the
  immediately-preceding post's compressed line (via the immutable `prevPageId` link) into
  the compress call so it can frame this post causally instead of in a vacuum. Verified
  against a real job: the prior summary was correctly found and passed. Still short of
  real cross-post redundancy checking across a whole window (already flagged in its own
  code comment) — that's a bigger, separate refinement, not in scope.
- **Archive prompt now asks for causal framing** (2026-07-01) — `ARCHIVE_SYSTEM_PROMPT`
  asks for a "but/therefore" throughline and preserving who-did-what-to-whom, instead of
  neutral listing. Pure wording change, already had full block context.
- **PC address (2nd/3rd/1st person) is an open design question, not a stub.** The core
  Author prompt currently keeps st2.json's existing convention (2nd person: "you push open
  the door") unchanged. Explicitly deferred pending real play-testing — don't resolve this
  from first principles; resolve it after seeing actual sessions.
- **Config > Prompts has no override editor for the Author's core prompt.** The core
  prompt exists now as a hardcoded constant (unlike Agent model/param settings, which are
  already DB-backed via `agent_configs` + the Agents UI). No DB column, no route, no UI
  field yet to let a user override it per-story or globally.
- **Superseded (2026-07-03): the forced-tool-calling worldbook extraction pipeline
  described below was deleted.** It was built 2026-07-01 as "Editor setup is a volley, not
  one model doing everything" — DeepSeek stayed conversational while a separate Worker-model
  pass (`runWorldbookExtraction`, `src/services/setup.ts`) recorded facts via looped, forced,
  single-entry-per-call tool calls. Its own noted gap proved decisive rather than tunable:
  extraction *completeness* was inconsistent across identical retries (same exchange
  establishing Setting+PC+Register sometimes recorded all three, sometimes one, sometimes
  none) — a capability ceiling, not a mechanical bug, and prompt tweaks only partially
  helped. This confirmed the doc's own "if this keeps being annoying" prediction: the fix
  was relaxing tool-use entirely, not a stronger model. Replaced with the bracket-regex
  approach now documented in loremaster.md's Structured Schema section — the Editor writes
  plain `[CONTENT]`/`[ROSTER]`/`[MEMORY]`-tagged prose, and the back end detects blocks via
  regex (`src/services/worldbook-extraction.ts`), verbatim, no model-side tool call, no
  structured fields. `src/services/setup.ts` was deleted entirely; worldbook entries dropped
  from six typed schemas to three freeform types; tags lost their manual `worldbookPageId`
  pointer and are now pure grep against post *and* worldbook content.
  **New open question, not yet resolved:** extraction reliability now depends on the model
  consistently emitting well-formed bracket pairs rather than on tool-calling fidelity — a
  malformed or unclosed tag simply produces zero entries silently (by design: "no match, no
  entry" per the regex's own backreference-matched-pair requirement), with no retry or
  validation loop backing it up the way forced tool-calling had. Verified live for a handful
  of real turns (one setup turn producing 1 CONTENT + 2 ROSTER + 1 MEMORY correctly, an
  update-session turn correctly finding zero), but not stress-tested across many turns or
  models yet — revisit if malformed/missing brackets turn out to be common in real use.
  This *is* the structural prerequisite loremaster.md's deferred Horde/generic-endpoint
  support (Future Phases appendix) needed — worldbook authoring no longer depends on the
  `tools`/`tool_calls` surface at all, only compression/archiving still do.

## UI

- **Input bar "weapon wheel"** (length/mood/param/model/effort toggles) — genuinely not
  started, doc's bespoke touch-first design deferred entirely in favor of plain controls.
- **Settings gained a generic JSON-space tree editor** (2026-07-02, `web/src/JsonSpaceEditor.tsx`
  + `src/db/settings-space-store.ts`) covering Banned words/phrases, Global CSS (light/dark
  color vars, root font size, narrow-screen breakpoint), Play tab (post font size, user/editor
  label visibility + text, editor-italics toggle), and Layout — collapsible tree view, a raw
  "JSON edit" fallback, save/cancel only when dirty, and a decline-not-throw on invalid JSON.
  Global CSS and Play tab also live-preview unsaved edits and one-step "revert to last saved."
  Still no **preference-profile CRUD** (named snapshots of the full settings state,
  `preference_profiles` table exists but unused) — that's the remaining gap from the original
  item.
- **Debug is scoped to the current story only**, not a cross-story view.
- **Logs telemetry only covers prose (story) posts.** `gen_metrics` isn't populated for
  compress/archive jobs, so queue-wide telemetry is incomplete.

## Infra / provider

- **Retired: the `stop`-parameter banned-phrases mechanism** (was `src/services/stop-list.ts`,
  removed 2026-07-02). Confirmed to have no practical use once refusal-prefix detection
  (`src/services/refusal-detection.ts`) covered the only case that mattered; the global
  generation-time `stop` list added risk (an unexpected mid-prose halt) for no real benefit.
  Settings' "Banned words/phrases" JSON space now edits the refusal-detection prefix list
  directly instead. `stop_token_ids` remains unimplementable per the `/v1/tokenize` finding
  in `docs/featherless-notes.md` — moot now that there's no string-`stop` feature to layer it
  on top of.
- **Agent slot costs are hardcoded**, not read from Featherless's real per-model
  `concurrency_cost` field (`docs/featherless-notes.md` TODOs).
- **`src/queue/slots.ts` is a local in-memory counter**, not backed by Featherless's real
  `/v1/account/concurrency` feed — can drift from ground truth, not urgent for a single
  local dev instance.
- **No same-model retry-after-backoff for 500/503.** Ranked-choice fallback to a
  *different* model exists and is tested; retrying the *same* model after a wait does not.
- **Cross-referencing HuggingFace's own tag API for real per-model tags** — deferred idea,
  not started; would need a ToS/rate-limit check first.
- **Config > Agents rebuilt as a flat, reorderable model list** (2026-07-02,
  `src/db/model-config-store.ts` + `src/routes/agents.ts` + `web/src/AgentsView.tsx`),
  replacing the old one-row-per-role `agent_configs` table (kept only as a one-time seed
  source — `ensureModelConfigsSeeded` in `src/services/agent-config.ts` migrates it into the
  new table the first time it's read, preserving whatever was actually live rather than
  resetting anyone's setup; verified live that it reproduced the pre-migration
  author/worker/editor profiles and fallback chain exactly). A row is a full call profile
  (model + temperature/limits + the six new sampler params — presence/frequency/repetition
  penalty, top_p, top_k, min_p, all optional and omitted from the request body when unset)
  with checkboxes for which role(s) it's eligible for; row order is the fallback chain
  position, shared across all roles that check a given row. Per-row success/fail counts and
  input/output token sums (same chars/4 estimate used elsewhere) are recorded on every real
  call via `recordModelOutcome`, keyed by the row's own id — verified live, a real forced-
  tool call bumped the right row's counters.
  **Known limitation:** `withModelFallback` still only swaps `.model` between candidates
  (pre-existing behavior, not new) — a fallback row's own temperature/limits/sampler params
  are stored and shown in the UI, but a role's *primary* row's params are what's actually
  used for every candidate in that role's chain at runtime, not each row's own. Rewriting
  `withModelFallback` to carry full per-candidate profiles would ripple through every retry
  loop in `pipeline-runner.ts`/`setup.ts`; out of scope for this pass, worth doing if
  per-fallback params turn out to matter in practice.
  **Also found and fixed while testing this:** the real CORS preflight for any DELETE route
  (Saves' delete-story, Settings' remove-banned-phrase) was answered by `index.ts`'s
  top-level middleware, not each sub-route's own — that middleware only listed
  `GET, POST, PATCH, OPTIONS`, so a real browser would have silently blocked every DELETE
  behind a CORS failure despite curl-based testing "passing" (curl doesn't preflight).
  Confirmed via a real preflight-shaped request before and after the fix.

## Data model

- **Fork copies worldbook state at its current (latest) form, not reconstructed as of the
  fork point's timestamp.** Fine for forks made close to the story's current state; a
  known simplification for forks made from far in the past. Adjacent to the doc's own
  deferred "worldbook deltas" idea.
- **Setup sequence and kickoff post are never archived as their own blocks** (doc steps
  6-7 of Kickoff) — trimmed as low-value until a Logs/Debug view exists that would
  actually surface them.

## Evaluated and declined

Ideas considered and explicitly decided against, recorded so they aren't re-litigated
without new information.

- **Pronoun declarations per tag** (loremaster.md's own Future Phases appendix; evaluated
  2026-07-01). The tag system (`src/services/tag-index.ts`) matches tag *names* via
  literal, case-insensitive, word-boundary regex against post text. Matching on declared
  pronouns ("she"/"her"/"he"/"they") would trigger on nearly every post regardless of
  which character is actually present, spamming false-positive tag matches and defeating
  the entire point of tags as a *selective* promotion mechanism. Making this useful would
  require real coreference resolution (knowing *which* "she" a pronoun refers to), not a
  small addition to the existing grep-based index. Revisit only if the tag-matching
  architecture itself changes.
