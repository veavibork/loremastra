# Session handoff

_Last updated: 2026-07-19 (format-probe plan agreed and written up — see Open items)._

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

**Model format probe** — full design in `docs/providers/format-probe-plan.md` (agreed
2026-07-19). Probe = the map, shape-based routing = the safety net, runtime tripwire =
staleness detection. Build order, each step ~one session, app working after each:

1. ~~**Length toggle re-enable**~~ — ✅ done 2026-07-19 (`5a8291a`); `0` = "Auto". Bonus same
   day (`61998b4`): "Layout buttons" editor in Settings + toggle.length resurrection via
   layout defaults.
2. ~~**Hypothesis corpus**~~ — ✅ done 2026-07-19: `src/data/format-hypotheses.ts` (see plan
   doc for contents/sources). Mined as hypotheses, never applied as config.
3. **Probe engine** (next) — productize `scripts/probe-*.ts` into a library: n≥2 per condition,
   reasoning field/tag detection, kwarg honoring both directions, stop-token leaks, broken
   template sanity check, `finish_reason` reliability.
4. **Profile storage + `model-probe` queue job** — `(provider, model_id)` table in global
   DB, auto-probe on agent save with unprofiled model, "Re-probe" button + profile summary
   in the Agents tab.
5. **Consumers** — splitter tags, prefill decision (retire `/deepseek/i`), per-model-aware
   Effort toggle, retry rules, HF metadata folded in.
6. **Runtime tripwire** — observed shape contradicts profile → flag model, suggest re-probe.

**Parked:** cache/persistent-error mystery (no repro; evidence capture is the prerequisite —
see plan doc), raw `/completions` escape hatch, mood/param/model toggles.

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
