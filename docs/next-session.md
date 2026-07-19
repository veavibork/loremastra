# Session handoff

_Last updated: 2026-07-19 (all four open items actioned: live-save check, retry visibility, coverage audit, push-driven queue)._

## State of the world

- **Deployed to VM (333e847)**, on top of the same day's fold fix (ea6b253) and Queue tab
  slot attribution (e20fb66):
  - **Live save repair — resolved, no action needed.** The skinwalker-fight gap (old seq 2
    claiming coverage through post 115) healed in regeneration before the fold; the seq-0
    deep-past digest now covers the full arc (verified by reading it on the VM). Do NOT
    delete seq 0 to "repair" anything — post-fold it is the only memory of posts 1–284.
  - **In-job retry visibility** — `withTransientRetry`/`withModelFallback` emit retry events;
    executors publish them as job progress labels ("Provider busy (503) — retrying X in 15s",
    "X unavailable — trying Y"). The jobs API carries a running job's live progress label and
    the Queue tab shows it in the response slot.
  - **Coverage audit (judge-as-detector)** — new `segment-audit` job type (jobs CHECK
    migration included). "Audit coverage" button per ready segment in the Segments tab runs
    the verify-ab-calibrated judge over the segment's coverage window: 3 votes, flagged at
    2+ fails, early exit when decided. Detector only — stores pass/flagged + missing-event
    lines on the segment (badge + list in the tab), never modifies content. Verdict clears
    automatically when segment content changes. Window capped at 40 posts (fold digests
    can't be meaningfully audited). Shares the one-Editor-job-at-a-time gate.
  - **Push-driven queue** — 'jobs' SSE pings now fire on claim/completion/cancel for every
    job type; the Queue tab polls (2s) only while something is pending/running and otherwise
    sits at zero polling, woken by SSE.
- **verify-ab experiment** (`scripts/story-to-date-verify-ab.ts`, findings in development.md):
  judge+rewrite pass rejected; window halved instead; DeepSeek-V4-Flash rejected as Editor.
  Editor stays on DeepSeek-V4-Pro. The judge prompt now lives on in
  `src/services/story-to-date/audit.ts` as the detector.
- **Worker-as-auditor A/B (2026-07-19, `scripts/segment-audit-model-ab.ts`)**: Hermes-3-8B
  (Worker) rejected for segment-audit — flags everything, asserts absence of events verbatim
  present in the block, no latency win. Audit stays Editor-tier. Findings in development.md.

## Open items

_(none — previous four all actioned 2026-07-19)_

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
  "overhang" line makes this visible when it happens.
