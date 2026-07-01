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
- **Editor can claim a worldbook entry was "locked in" without the matching tool call
  landing.** Optional/judgment-call tool use can't be forced-and-retried the way
  compress/archive's tool calls are. Mitigated (live worldbook preview panel lets a human
  catch the mismatch; system prompt now tells the model not to claim success without a
  same-turn tool call) but not eliminated — a structural risk of "auto" tool-choice, not a
  bug to fix outright.

## UI

- **Input bar "weapon wheel"** (length/mood/param/model/effort toggles) — genuinely not
  started, doc's bespoke touch-first design deferred entirely in favor of plain controls.
- **Settings has no UI-preference controls** (dark/light, font size, etc.) or
  preference-profile CRUD — only the layout JSON editor exists.
- **Debug is scoped to the current story only**, not a cross-story view.
- **Logs telemetry only covers prose (story) posts.** `gen_metrics` isn't populated for
  compress/archive jobs, so queue-wide telemetry is incomplete.

## Infra / provider

- **Agent slot costs are hardcoded**, not read from Featherless's real per-model
  `concurrency_cost` field (`docs/featherless-notes.md` TODOs).
- **`src/queue/slots.ts` is a local in-memory counter**, not backed by Featherless's real
  `/v1/account/concurrency` feed — can drift from ground truth, not urgent for a single
  local dev instance.
- **No same-model retry-after-backoff for 500/503.** Ranked-choice fallback to a
  *different* model exists and is tested; retrying the *same* model after a wait does not.
- **Cross-referencing HuggingFace's own tag API for real per-model tags** — deferred idea,
  not started; would need a ToS/rate-limit check first.

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
