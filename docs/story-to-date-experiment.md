# Story-to-date memory

**Status: shipped in production (2026-07-04).** Replaces per-post compression and decad `[EVENT SUMMARY]` archive blocks.

Related: [loremaster.md](../loremaster.md) Story-to-Date Memory Pipeline, assembly in `src/services/history.ts`.

---

## Production behavior

| Setting             | Value                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------- |
| **Trigger**         | Assembled Author prompt ≥ **80%** of usable context                                    |
| **Editor input**    | **80%** full log to trigger point                                                      |
| **Coverage**        | Absolute IC post number; `[COVERAGE]N[/COVERAGE]`                                      |
| **Seam gate**       | If coverage == input ceiling → one retry with step-back prompt                         |
| **Assembly**        | system → worldbook → merged `[STORY TO DATE]` → verbose posts after last coverage only |
| **Invalidation**    | Edit/fork inside coverage window deletes affected segments                             |
| **Scene titles**    | Worker `segment-name` jobs on filled segments — **Segments tab only**                  |
| **Legacy archives** | `archive` / `archive_member` rows purged on story DB open — fully retired 2026-07-12   |

Implementation:

| Area                   | Path                                              |
| ---------------------- | ------------------------------------------------- |
| Trigger / enqueue      | `src/services/story-to-date.ts`                   |
| Editor worker          | `src/services/story-to-date-worker.ts`            |
| Corpus / merge / parse | `src/services/story-to-date-corpus.ts`            |
| Store                  | `src/db/story-to-date-store.ts`                   |
| Assembly               | `src/services/history.ts`                         |
| Segments UI            | `web/src/views/SegmentsView.tsx`                  |
| HTTP                   | `GET/POST/PATCH /api/stories/:id/story-to-date/*` |

---

## Local experiment harness

Use the harness to iterate on prompts **before** changing production defaults — same corpus helpers as the pipeline (`src/services/story-to-date-corpus.ts`).

### Sync data from VM

```powershell
.\scripts\pull-remote-data.ps1
$env:LOREMASTER_DATA_DIR = "data/vm-sync"
```

### Commands

```bash
npx tsx scripts/story-to-date-experiment.ts list
npx tsx scripts/story-to-date-experiment.ts corpus <storyId> --cutoff 0.8 --trigger 0.8
npx tsx scripts/story-to-date-experiment.ts run <storyId> --mode begins --cutoff 0.8 --dry-run
npx tsx scripts/story-to-date-experiment.ts run <storyId> --mode continues --from-artifact data/experiments/story-to-date/<dir> --cutoff 0.8
```

Each run writes prompts, raw responses, extracted blocks, and merged `[STORY TO DATE]` under `data/experiments/story-to-date/<timestamp>/`.

---

## Tuning notes (from 2026-07-04 experiments)

| Pattern                   | Observation                                                               |
| ------------------------- | ------------------------------------------------------------------------- |
| **Begins**                | ~400–455 words for ~71 posts (~6 words/post)                              |
| **Continues (good seam)** | ~600 words for ~80 new posts (~7–8 words/post)                            |
| **Ceiling-hitting**       | Coverage = ceiling → bloat or verbatim tails; seam retry fixes most cases |
| **Sweet spot**            | ~500–650 words per continues block on the test story                      |

`extractStoryName` rejects chat-template token leaks and colon-and-tagline titles so scene names stay short labels.

---

## Retired — do not rebuild without explicit design

- Per-post Worker compression (`gen_extract`, 5-post lag, `compress` jobs)
- Non-overlapping decad archive blocks (`[EVENT SUMMARY]` every 10 posts)
- Tag-driven promotion of compressed/archive tiers in assembly
- Setup/kickoff-specific archive blocks

All old code paths deleted 2026-07-12 as part of disambiguation resolution (46 items across 6 phases).
