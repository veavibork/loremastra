# Story-to-date archival — experiment plan

Exploratory tooling for a long-term memory strategy that replaces (or supplements) per-decad
`[EVENT SUMMARY]` blocks with one rolling `[STORY TO DATE]` narrative. **Not in production yet.**

Related: [roadmap.md](roadmap.md) mega-archive item, current assembly in `src/services/history.ts`.

---

## The idea (your proposal)

| Stage | Behavior |
|-------|----------|
| **Trigger** | When the full Author prompt (system + worldbook + all verbose prose) reaches **80%** of usable context |
| **Job input** | Worldbook + verbose prose through the **80%** mark (full log to trigger — nothing beyond existed yet) |
| **First pass** | Editor produces `[STORY BEGINS]…[/STORY BEGINS]` — loadbearing events in fiction register |
| **Later passes** | Editor produces `[STORY CONTINUES]…[/STORY CONTINUES]` picking up after prior coverage |
| **Seam gate** | If `[COVERAGE]` equals input ceiling, retry once with step-back instruction |
| **Assembly** | Merge all segments into one `[STORY TO DATE]…[/STORY TO DATE]` in the Author prompt |

Decad archives remain useful as a **stepping stone** and for A/B comparison during this experiment.

---

## Sync data from VM (local experiments)

Live story data lives on the GCP VM. Pull a checkpointed copy into `data/vm-sync/` without
touching your local `data/` (which may be locked by a running dev server):

```powershell
.\scripts\pull-remote-data.ps1
```

Then point tools at the sync copy:

```powershell
$env:LOREMASTER_DATA_DIR = "data/vm-sync"
npx tsx scripts/story-to-date-experiment.ts list
npx tsx scripts/story-to-date-experiment.ts corpus 019f25e0-219c-7189-b481-9f389a9a3c39 --cutoff 0.8
```

For Featherless **`run`** calls, either:

- Set `FEATHERLESS_API_KEY` in the shell (simplest), or
- Copy the VM's `APP_MASTER_KEY` into local `.env` so DB-stored keys decrypt

---

## Tooling

```bash
# List stories (pick your ~400-post story id)
npx tsx scripts/story-to-date-experiment.ts list

# Token stats + export corpus input (no LLM call)
npx tsx scripts/story-to-date-experiment.ts corpus <storyId> --cutoff 0.8 --trigger 0.8

# Dry-run: write prompts to data/experiments/story-to-date/<timestamp>/
npx tsx scripts/story-to-date-experiment.ts run <storyId> --mode begins --cutoff 0.8 --dry-run

# Hit Featherless (Editor profile + key from DB, same as the app)
npx tsx scripts/story-to-date-experiment.ts run <storyId> --mode begins --cutoff 0.8

# Continue from a prior artifact directory
npx tsx scripts/story-to-date-experiment.ts run <storyId> --mode continues --from-artifact data/experiments/story-to-date/<prior-dir> --cutoff 0.8

# Stress mid-scene ceiling (forces input through post N)
npx tsx scripts/story-to-date-experiment.ts run <storyId> --mode continues --from-artifact <dir> --through-post 142

# Skip seam retry gate
npx tsx scripts/story-to-date-experiment.ts run <storyId> --mode begins --no-seam-retry

# Iterate on prompt language without code changes
npx tsx scripts/story-to-date-experiment.ts run <storyId> --mode begins --system ./my-prompt.txt
```

Each run writes:

| File | Purpose |
|------|---------|
| `corpus-meta.json` | Token counts, cutoff post number, trigger stats |
| `messages.json` | Full chat payload sent to Featherless |
| `system-prompt.txt` / `user-prompt.txt` | Easy diff while iterating |
| `response-raw.txt` | Unparsed model output |
| `response-raw-retry.txt` | Second pass when seam gate fires |
| `metrics.json` | Word count, coverage, `seamRetried` |
| `block-begins.txt` or `block-continues.txt` | Extracted bracket block |
| `segments.json` | Ordered segments for merge |
| `story-to-date-merged.txt` | What Author prompt assembly would inject |

Shared logic: `src/experiments/story-to-date-corpus.ts` (isolated from production paths).

---

## Suggested iteration loop

1. **`corpus`** on your live story — confirm `wouldTrigger: true`, note `inputCeilingPost` at 0.8.
2. **`run --mode begins --dry-run`** — read `user-prompt.txt`; trim if Editor input is huge.
3. **`run --mode begins`** — review `block-begins.txt` for register, loadbearing facts, hallucinations.
4. Edit a copy of `system-prompt.txt`, re-run with `--system ./my-prompt.txt`.
5. **`run --mode continues`** with `--from-artifact` pointing at the begins run — check seam quality.
6. Compare merged `[STORY TO DATE]` token cost vs current `[EVENT SUMMARY]` chain at same history depth.
7. Only after quality is stable: design DB schema + queue job + assembly hook.

---

## Issues to discuss before committing

### 1. Trigger vs input cutoff

Trigger and Editor input both use **80%** of usable budget in current experiments — the log supplied ends at the trigger point; prompt instructs the model to roll `[COVERAGE]` back to the previous scene seam if that post is mid-scene. Production should compute budgets from each model's own context/response limits.

### 2. Word count vs quality (2026-07-04 experiments)

| Pattern | Observation |
|---------|-------------|
| **Begins** | ~400–455 words for ~71 posts — stable, ~6 words/post |
| **Continues (good seam)** | ~600 words for ~80 new posts at coverage 151 — ~7–8 words/post |
| **Ceiling-hitting** | Coverage = ceiling correlates with bloat (763w) or verbatim tails (908w) |
| **Step-back** | Seam retry or natural rollback cuts words *and* fixes endings — quality does not require length |
| **Thin retry** | Aggressive step-back can over-compress (221w) — same seam, less loadbearing detail |

Consider an output word ceiling in production once the seam gate is wired; empirically **~500–650 words per continues block** hit the sweet spot on the test story.

### 3. Overlap / invalidation on edit

Decad archives invalidate when canon text inside the window changes. `[STORY TO DATE]` covering posts 1–240 would need the same rule: any edit inside covered range → regen from that segment forward (or full regen). Worth deciding up front.

### 4. Continues boundary precision

The experiment cuts at a **post boundary** when token budget fills. `[STORY CONTINUES]` must start at the **next** post, with zero overlap. Store `cutoffPageId` on each segment row (the corpus builder already computes this).

### 5. Relationship to decad archives

During transition you could:

- **Replace** event summaries entirely (simpler assembly),
- **Layer** both (risky — redundant/conflicting memory),
- **A/B** via experiment flag (recommended while iterating).

### 6. Editor model vs Worker

Archive naming/summary quality varied by model. Story-to-date is **high stakes** — Editor tier (as you proposed) is right; expect longer jobs and higher token cost than decad summaries.

### 7. Output length budget

A `[STORY BEGINS]` covering 200+ posts at 60% cutoff could still ask for a very long block. Consider an explicit **word/token ceiling** in the prompt (like archive's 80 words per decad, but scaled — e.g. 400–800 words for a "book chapter" recap).

### 8. Special tokens / format leaks

Archive naming returned raw chat-template tokens (`<\|…\|>`). Same validation needed on story block extraction before persisting.

### 9. Register drift

Summaries must match CONTENT Register. Pulling register lines from worldbook into the system prompt (like archive worker does with PC name) helps — add if begins output sounds too clinical.

---

## Open prompt questions (iterate in `--system` files)

- How much **NPC interiority** vs **plot skeleton**?
- Include **unresolved hooks** explicitly ("Suki hasn't replied yet")?
- **Third person** only (match archive rules) — confirm.
- Should `[STORY CONTINUES]` be allowed to **correct** errors in prior `[STORY TO DATE]` if the log contradicts it, or strictly append-only?

---

## Archive naming hardening (shipped alongside this doc)

`extractStoryName` now rejects chat-template token leaks and colon-and-tagline titles (`Foo: Bar, Baz`) so scene names stay short labels, not subtitles.
