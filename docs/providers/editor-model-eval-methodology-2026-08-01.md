# Editor model evaluation methodology (2026-08-01)

Triggered by a real quality complaint, not a synthetic benchmark: while running
`Qwen/Qwen3.6-35B-A3B` as the Editor (chasing a faster/cheaper alternative to the DeepSeek-V4-Pro
default), several VM segments were found to have dropped load-bearing detail — the eye-contact
beat between the protagonist and a captured ghost, and the cause of an injury that seeds a future
plot thread — reduced to vague labels ("the supernatural threat", "her injured arm") with no
antecedent. This doc is the reusable process for answering "is this an editor-model problem, and
if so, which model/config actually fixes it" — not a scorecard to keep re-reading after models and
prices move on.

**Related:** [model-shape-probe-2026-07-17.md](model-shape-probe-2026-07-17.md),
[featherless-notes.md](featherless-notes.md).

## Method

### 1. Test against a real, known-bad scene — not a synthetic prompt

Pulled the actual production save (VM story `019fa8c7`) locally rather than inventing test prose.
A synthetic scene risks accidentally being easy; a real scene that already failed in production
is a known-hard case with a verifiable ground truth (the raw log posts) to check outputs against.

```
# On the VM: checkpoint WAL so the copy is complete, then scp to scratchpad (Desktop paths silently
# fail with gcloud scp — copy to scratchpad first, then move into the repo).
sqlite3 global.sqlite "PRAGMA wal_checkpoint(TRUNCATE);"
sqlite3 stories/<id>.sqlite "PRAGMA wal_checkpoint(TRUNCATE);"
gcloud compute scp <instance>:/opt/loremaster/data/global.sqlite <scratchpad>/ --zone=<zone>
gcloud compute scp <instance>:/opt/loremaster/data/stories/<id>.sqlite <scratchpad>/ --zone=<zone>
# then cp into data/vm-sync/{global.sqlite, stories/<id>.sqlite} locally, drop stale -wal/-shm files
```

Every experiment script in this repo (`story-to-date-*-ab*.ts`) reads via
`LOREMASTER_DATA_DIR=data/vm-sync`, so once synced, no further plumbing is needed.

### 2. Find exactly where the dropped detail lives in the raw log first

Before touching prompts or models, grepped the raw `text` table for the missing details' keywords
to confirm they're actually inside the segment's claimed coverage window (not a real cross-window
gap). This matters: if the detail isn't in the window at all, the fix is windowing, not the model.

### 3. Build one generalized experiment harness, not a new script per idea

`scripts/story-to-date-guidance-ab.ts` — production-parity generation (mirrors
`worker.ts`'s seam-gate/sprint-gate retry logic exactly, borrowed from
`story-to-date-verify-ab.ts`) parameterized by **arm** = guidance text × sampler override ×
checklist-scaffold flag × model override. Every new variable to test became a new arm in the same
table, not a new file — kept all results comparable and all artifacts in one place
(`data/experiments/guidance-ab/<timestamp>/`).

### 4. Score by keyword ground-truth, not just the LLM judge

The judge prompt (borrowed from `verify-ab.ts`) is useful but noisy in two specific ways found
live:

- **It sometimes rambles** — one trial's judge response was 66 lines of the model second-guessing
  itself about whether a hallucinated event counts as "missing," not 66 real omissions. Skimming
  the missing-list text, not just the pass/fail verdict or its length, is necessary.
- **Its severity standard shifts with the model used to run it.** Naively, `judgeProfile` inherited
  whatever model was under test — so DeepSeek-as-judge (very literal, nitpicks minor phrasing) and
  Qwen-as-judge (looser) are not comparable severities. A DeepSeek generation scored by a DeepSeek
  judge can show a _worse_ raw pass-rate than a Qwen generation scored by a Qwen judge, despite the
  DeepSeek output being categorically more complete. **Fix for next time: pin the judge to one
  fixed model for every arm, regardless of which model is under test.**

Given that, the actual comparable metric across models ended up being a **direct keyword check on
final-block text** for the specific facts known to matter (e.g. `grep -Ei "gaze|looked at|eye
contact"`) — crude, but judge-independent and consistent across every model tried:

```bash
for f in "$DIR"/*/final-block.txt; do
  gaze=$(grep -Eiq "gaze|looked at|eye contact|..." "$f" && echo YES || echo no)
  cause=$(grep -Eiq "paint can" "$f" && echo "YES(cause)" || (grep -Eiq "elbow|injur|splint" "$f" && echo vague-only || echo no))
  echo "$f: gaze=$gaze injury=$cause"
done
```

### 5. Don't trust n=1, but don't over-invest before the signal is even directional

Single-trial spot checks are useful only to smoke-test the harness works end-to-end. Real
comparisons need 5-10 trials per arm minimum — LLM output variance at temperature≈1 is large
enough that a single trial can show either the best or worst case for any arm.

## Results summary (as of this doc)

Guidance-text tweaks and temperature alone (tested 0.3/0.6/1.0 × baseline/"cause-clause" wording,
all on `Qwen/Qwen3.6-35B-A3B`) **did not converge** — no combination reliably kept both target
details; the noise between arms was often larger than the effect being measured. What did move the
needle:

- **Checklist/scaffolding** (`buildChecklistSystemPrompt` — ask the model to enumerate consequential
  events under `[EVENTS]` before writing the compressed block, same single API call) took Qwen from
  ~46% gaze-retention to ~87.5%, and any-injury-mention to 100%. Extraction and compression appear
  to be different cognitive loads for a lightweight model; splitting them helps more than any
  prompt wording change did.
- **Model choice was the largest lever by far.** DeepSeek-V4-Pro hit 100% gaze / 100% any-injury /
  60% cause-specific on the very first baseline pass, no tuning. `zai-org/GLM-5.2` matched or beat
  that (80% gaze / 100% cause) while running faster (42–90s/call vs Pro's 70–130s) — GLM-5.2 is the
  current leading Editor candidate, pending sampler-tuning and scaffold-stacking follow-up.
- Mid-tier 70B models (Hermes-3-Llama-3.1-70B, TheDrummer/Anubis-70B-v1.2) showed no quality edge
  over a well-scaffolded lightweight model, while costing more (4 concurrency units vs Qwen's 2)
  and, in Hermes's case, being both slow _and_ under-covering per call — worse on every axis that
  matters for the "faster than flagship" goal.

## Infrastructure lessons (apply to any future model-comparison round)

- **A killed local task does not cancel the request on Featherless's side.** `TaskStop`/killing the
  bash process only drops the client's wait — the generation keeps running server-side, still
  billed against the account's concurrency pool, until it finishes or Featherless's own timeout
  fires. Killing and immediately retrying just stacks a second reservation on top of the orphaned
  one and guarantees a 429. Check the live feed before retrying after a kill:
  `GET /account/concurrency/stream` (SSE, `{limit, used_cost, requests: [{model, duration_ms}]}`) —
  `src/queue/concurrency-feed.ts` already implements this pattern for the app itself.
- **Run one model at a time.** Per-model concurrency cost varies (2 units for Qwen, 4 for most
  70B+/flagship-class models on this account's `feather_claw_pro` plan, 8-unit total limit) and
  isn't known ahead of time — two "large" models in flight at once reliably exceeds the plan limit.
- **A model can fail for reasons that have nothing to do with quality**, each needing a different
  response, not a shared "it's bad" conclusion:
  - Gated behind provider-side license/OAuth (`meta-llama/Llama-3.3-70B-Instruct` — 403,
    non-transient across 5 retries, needs HuggingFace org verification on the Featherless account
    itself; out of this repo's control).
  - A reproducible formatting bug independent of content quality (`deepseek-ai/DeepSeek-V4-Flash`
    drops the leading `[` on `[STORY CONTINUES]` 10/10 times — trivially repairable by prepending
    `[` before parsing if the raw response starts with `STORY CONTINUES]`, and worth doing before
    writing the model off).
  - Genuinely, reproducibly slow inference on Featherless's backend, confirmed by a raw streaming
    probe rather than assumed (`poolside/Laguna-S-2.1` streamed at ~5-7 chars/sec — confirmed via a
    bare `stream: true` fetch with per-chunk timestamp logging, not the full harness, to rule out a
    parsing/shape bug before concluding "just slow"). A model this slow disqualifies itself
    regardless of quality; don't burn further trials proving it twice.
  - Model-not-found (unreleased on Featherless yet, e.g. `deepseek-ai/DeepSeek-V4-Flash-0731` — a
    single-trial ping is enough to confirm 404 and move on) vs. transiently busy
    (`arcee-ai/Trinity-Large-Thinking` — "This model is busy" on 5/5 attempts; worth one retry
    later, not a verdict on the model itself).

## Reusable artifacts

- `scripts/story-to-date-guidance-ab.ts` — the generalized harness (arms = guidance × sampler ×
  checklist × model). Add new arms to `ALL_ARMS`/`GUIDANCE_VARIANTS` rather than forking the file.
- `data/vm-sync/` — the synced VM save used for every run in this round; refresh via the
  checkpoint+scp steps above when testing against newer production data.
- `data/experiments/guidance-ab/<timestamp>/` — every trial's raw completion, judge output, and
  final block, plus `summary.json`/`rows.json` per run.
