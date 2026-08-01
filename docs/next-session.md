# Session handoff

_Last updated: 2026-08-01 (story-to-date fold/segment stress-testing round — see Open items)._

## State of the world

- **Deployed to VM (5e29fda), 2026-08-01.** Since the 2026-07-19 format-probe work below (now
  fully shipped, kept for its build-order record): a coverage/fold audit pass over the
  story-to-date pipeline —
  - **Fold batch fix** — `selectFoldBatch` no longer requires a batch of ≥2 segments; a lone
    oversized segment can fold on its own. Fixes both a truncation bug and a segment that could
    never fold.
  - **Mid-scene-ending detection** — `looksLikeMidSceneEnding` (engine.ts) catches segments whose
    trailing sentences describe an unresolved/in-progress beat, gating them out before they're
    accepted.
  - **Editor model eval** — full bake-off methodology in
    `docs/providers/editor-model-eval-methodology-2026-08-01.md`. `zai-org/GLM-5.2` matched or
    beat `DeepSeek-V4-Pro` on the tested quality metrics while running faster; **promoted to the
    live production Editor** (`model_configs`, temperature 0.8 — note the legacy `agent_configs`
    table is stale/unused, real config reads from `model_configs`).
  - **GLM-5.2 marker-drop repair** — live stress testing found GLM-5.2 intermittently omitting the
    opening `[STORY CONTINUES]`/`[STORY BEGINS]` bracket while still writing clean prose and a
    valid closing `[COVERAGE]` tag. `extractStoryBlockMissingOpenTag` (engine.ts) repairs this
    specific shape only (gated on no other marker debris present); a raw-text diagnostic log
    (`worker.ts`, warn-level) is still live in case another failure shape shows up.
  - **`logit_bias` corrected** — the 2026-07-02 "dead, no token-level control possible" finding
    doesn't generalize; confirmed working on both `/v1/completions` and `/v1/chat/completions`
    for `zai-org/GLM-5.2`. See `docs/providers/featherless-notes.md`'s 2026-08-01 correction
    section and `docs/providers/logit-bias-word-suppression-plan-2026-08-01.md` (design only,
    explicitly paused — see Open items).
- **Deployed to VM (333e847), 2026-07-19**, on top of the same day's fold fix (ea6b253) and Queue tab
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

**Story-to-date stress testing (active, 2026-08-01)** — user is running a from-scratch stress
test on the VM against the newly-promoted GLM-5.2 Editor. Watch for:

- Any _new_ parse-failure shape in `data/outbound-requests.log` (grep `missing block or coverage`
  and `repaired missing opening story marker`) beyond the one already repaired.
- If the marker-drop failure recurs at a meaningful rate, user's own next step is trying editor
  temperature 0.6 (currently 0.8, untested in the original eval which only covered 0.3/0.6/1.0).

**Parked, explicitly not to be picked up without a fresh ask:**

- `logit_bias` word-suppression productionization — design-only plan written
  (`docs/providers/logit-bias-word-suppression-plan-2026-08-01.md`), paused so the user could
  prioritize the stress testing above. Resume as its own project.
- **DeepSeek-V4-Pro GA checkpoint** — DeepSeek's "Pro" model is expected to reach general
  availability soon (Featherless/DeepSeek's own messaging as of 2026-08-01, currently pre-GA).
  When it ships, re-run `scripts/story-to-date-guidance-ab.ts` against it before deciding whether
  GLM-5.2 stays as the production Editor long-term.
- Token-budget corpus windowing (`maxIncludedTokens` option added to `engine.ts`'s
  `CorpusOptions`, scaffolded but not yet experimentally exercised or decided on, as an
  alternative to the current flat `NEXT_SCENE_INPUT_WINDOW_POSTS` post-count window).

---

**Model format probe** — ✅ **fully shipped and archived 2026-07-19** (all 6 steps below done).
Full design in `docs/providers/format-probe-plan.md`. Probe = the map, shape-based routing = the
safety net, runtime tripwire = staleness detection. Build order, each step ~one session, app
working after each:

1. ~~**Length toggle re-enable**~~ — ✅ done 2026-07-19 (`5a8291a`); `0` = "Auto". Bonus same
   day (`61998b4`): "Layout buttons" editor in Settings + toggle.length resurrection via
   layout defaults.
2. ~~**Hypothesis corpus**~~ — ✅ done 2026-07-19: `src/data/format-hypotheses.ts` (see plan
   doc for contents/sources). Mined as hypotheses, never applied as config.
3. ~~**Probe engine**~~ — ✅ done 2026-07-19: `src/inference/format-probe.ts` + harness
   `scripts/format-probe.ts`. Live-validated on Qwen3-8B: shape is per-condition
   (`shapeByCondition` — no kwargs → inline `<think>`, explicit kwargs → `reasoning` field)
   and `thinking_budget` is ignored there. See plan doc.
4. ~~**Profile storage + probe runner**~~ — ✅ done 2026-07-19: global `model_format_profiles`
   table doubling as the probe queue + `src/queue/probe-runner.ts` (NOT a story-job — jobs
   are story-scoped; see plan doc for the deviation). Auto-probe on agent save with a
   never-probed model; Probe/Re-probe/Cancel + chip summary per Agents card; active probes
   in the Queue tab; panic button covers probes. Live-smoke-tested (also fixed: all-calls-
   failed probes now land as `failed`, not a garbage `done` profile).
5. ~~**Consumers**~~ — ✅ done 2026-07-19: `src/services/model-format.ts` (pure cores +
   DB wrappers, name-heuristic fallback for unprofiled models) drives splitter tags,
   prefill, and idle timeout; Effort label carries per-model caveats; hfTags in the
   profile API. Fixed on the way: prose.ts force-prefilled `/deepseek/i` even with
   thinking off (bypassing the guard); new decision live-validated on DeepSeek-V4-Pro.
   Deliberately unchanged: shape-based retry rules, `stripThinkingTags` (see plan doc).
6. ~~**Runtime tripwire**~~ — ✅ done 2026-07-19: `reportFormatDrift` after every successful
   stream; one-sided checks (appearance contradicts profile → flag; silence never flags);
   first-detection-wins drift columns, cleared by successful re-probe; red chip in Agents
   tab. No auto-re-probe on drift (slots mid-play) — deliberate, see plan doc.

**All six steps done.** Remaining follow-ups live in the plan doc: non-streamed
Worker/Editor calls are outside profile consumers + tripwire; prefill stays
deepseek-family-gated pending A/B evidence.

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
