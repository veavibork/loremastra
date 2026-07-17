# Session handoff

_Last updated: 2026-07-17 (segment coverage fix + streaming review + verify-ab + deploy)._

## State of the world

- **Deployed to VM (964381e)**: story-to-date bounded window (12 posts/continues job),
  streaming-review fixes (SSE abort teardown, failed-job reattach as error, dead wait-phase code
  removed, memory-wait label server-push), SSE data-change invalidation replacing
  Worldbook/Segments 3s polling, job-created pings on the story channel, graceful shutdown on
  SIGTERM/SIGINT (verified live in journald), Horde poll throttle, worldbook inline edit-in-card.
- **verify-ab experiment** (`scripts/story-to-date-verify-ab.ts`, findings in development.md):
  judge+rewrite pass rejected; window halved instead; DeepSeek-V4-Flash rejected as Editor.
  Editor stays on DeepSeek-V4-Pro.

## Open items

1. **Live save repair** — story `019f62e5` ("Default Storeee") still has segment seq 2
   ("Vulnerability Unveiled") claiming coverage through post 115 while summarizing only the couch
   scene; the skinwalker fight (posts 60–99) is absent from memory. Fix: delete that segment in
   the Segments tab — regeneration chains automatically with the new 12-post windows.
2. **Judge-as-detector (optional)** — the coverage judge reliably finds real missing events but
   is too noisy for unattended gating; if wanted later, run it detector-only to flag segments in
   the Segments tab, with majority-vote calibration.
3. **Queue tab push-driven (optional)** — 'jobs' pings fire on creation only; claim/finish still
   ride the 2s poll. Publishing those transitions would let the poll go entirely.

## Deferred frontend items

- **Settings editor UX** — schema-driven forms for global CSS, play tab, banned phrases.
  Validated JSON textarea for layout config and toggle presets. `json-edit-react` already
  removed. Layout/toggle preset handling deferred until forms are in place.
- **Context budget visualization** — token usage breakdown shown to user (gap vs SillyTavern).
- **Per-response metadata** — model, timing, token count per response (gap vs KoboldAI /
  SillyTavern).
- **Preference profiles UI** — CRUD API exists at `/api/preference-profiles`; no frontend UI yet.

## Known limitations (non-fixable)

- Featherless server-side request cancellation unsupported — aborting the client fetch may not
  free their concurrency slot until the generation finishes server-side.
