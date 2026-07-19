# Session handoff

_Last updated: 2026-07-19 (fold truncation fix + Queue tab slot attribution, both deployed)._

## State of the world

- **Deployed to VM (e20fb66)**:
  - **Fold fix (ea6b253)** — every VM fold job had failed "likely truncated at Editor
    max_tokens": the instructed digest target estimated to more tokens than the rejection
    threshold, so a compliant model was rejected every time. Now `completeChatWithMeta`
    exposes `finish_reason` (ground truth for a max_tokens cutoff), the length heuristic is a
    backstop only, and the target sizing keeps real headroom (~1911 words at 4096).
    Verified live: fold job `019f7a4c` on story `019f62e5` completed in 3m33s, absorbed
    segments seq 19–28 into the seq-0 digest, deleted the rest. Total memory still slightly
    over the 6000-token soft cap — the next natural fold converges further (by design).
  - **Queue tab (e20fb66)** — slots header now shows the Featherless feed's own count as the
    headline, lists each held slot with what holds it (job type, agent role, story, cost, age),
    and calls out provider-side "overhang" (usage with no local job — lingering aborts/retries,
    previously invisible). Jobs list is two-line cards for tablet use (line 1: created, type,
    agent, status, turnaround, tokens; line 2 smaller: model, cost, priority, response). Jobs
    API now includes `agentRole`. Legacy `used/max` (which double-counts feed + reservation)
    kept for gating; display no longer uses it.
- **verify-ab experiment** (`scripts/story-to-date-verify-ab.ts`, findings in development.md):
  judge+rewrite pass rejected; window halved instead; DeepSeek-V4-Flash rejected as Editor.
  Editor stays on DeepSeek-V4-Pro.

## Open items

1. **Live save repair** — story `019f62e5` ("Default Storeee") still has segment seq 2
   ("Vulnerability Unveiled") claiming coverage through post 115 while summarizing only the couch
   scene; the skinwalker fight (posts 60–99) is absent from memory. Fix: delete that segment in
   the Segments tab — regeneration chains automatically with the new 12-post windows.
   (Note: seq 0–28 have since folded into one digest — check whether the gap survived the fold
   before repairing.)
2. **In-job retry visibility (optional)** — `withTransientRetry`/`withModelFallback` retries
   still don't surface per-attempt state; publishing a progress label ("retrying, attempt 2")
   from those wrappers would show it in the running job's row. The slot-holder list narrows the
   mystery (the job visibly holds its slot) but doesn't show the attempt count.
3. **Judge-as-detector (optional)** — the coverage judge reliably finds real missing events but
   is too noisy for unattended gating; if wanted later, run it detector-only to flag segments in
   the Segments tab, with majority-vote calibration.
4. **Queue tab push-driven (optional)** — 'jobs' pings fire on creation only; claim/finish still
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
  free their concurrency slot until the generation finishes server-side. The Queue tab's
  "overhang" line now makes this visible when it happens.
