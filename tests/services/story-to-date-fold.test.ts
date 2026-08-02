/**
 * Fold digest sizing invariants.
 *
 * Regression context (2026-07-19, VM story 019f62e5): every fold job failed with
 * "fold digest likely truncated at Editor max_tokens (4096) — refusing to apply".
 * The instructed target (~2436 words) estimated to MORE tokens than the truncation
 * rejection threshold, so a model that obeyed the prompt was rejected every time.
 * These tests pin the ordering: instructed target < backstop rejection line.
 */
import { describe, it, expect } from 'vitest'
import {
  foldCeilingTokens,
  foldDigestTargetWords,
  looksFoldDigestTruncated,
  selectFoldBatch,
  selectFoldSet,
  selectFoldTierShrinkSet,
  estimateTokens,
  CHARS_PER_TOKEN_ESTIMATE,
  FOLD_CEILING_MULTIPLIER,
  FOLD_KEEP_RECENT_TOKENS,
  FOLD_MAX_OUTPUT_TOKEN_RATIO,
  FOLD_PROSE_CHARS_PER_WORD,
  type FoldableSegment,
  type SegmentKind,
} from '../../src/services/story-to-date/engine.js'

const RESPONSE_LIMITS = [1024, 2048, 4096, 8192]

/** Synthetic prose of exactly `words` words at `charsPerWord` chars each (incl. trailing space). */
function proseOfWords(words: number, charsPerWord = FOLD_PROSE_CHARS_PER_WORD): string {
  return ('x'.repeat(charsPerWord - 1) + ' ').repeat(words).trim()
}

describe('fold digest sizing', () => {
  it.each(RESPONSE_LIMITS)(
    'a digest written exactly at the instructed target is not flagged truncated (limit=%d)',
    (limit) => {
      const targetWords = foldDigestTargetWords(Number.MAX_SAFE_INTEGER, limit)
      expect(looksFoldDigestTruncated(proseOfWords(targetWords), limit)).toBe(false)
    },
  )

  it.each(RESPONSE_LIMITS)(
    'tolerates wordier-than-average prose at target length (7 chars/word, limit=%d)',
    (limit) => {
      const targetWords = foldDigestTargetWords(Number.MAX_SAFE_INTEGER, limit)
      expect(looksFoldDigestTruncated(proseOfWords(targetWords, 7), limit)).toBe(false)
    },
  )

  it.each(RESPONSE_LIMITS)(
    'instructed target estimates below the backstop rejection line (limit=%d)',
    (limit) => {
      const targetWords = foldDigestTargetWords(Number.MAX_SAFE_INTEGER, limit)
      const targetEstTokens = estimateTokens(proseOfWords(targetWords))
      expect(targetEstTokens).toBeLessThan(Math.floor(limit * FOLD_MAX_OUTPUT_TOKEN_RATIO))
    },
  )

  it.each(RESPONSE_LIMITS)(
    'still flags a digest that actually ran to max_tokens (limit=%d)',
    (limit) => {
      // A real cutoff at max_tokens: ~limit real tokens of prose ≈ limit × 4 chars.
      const nearCapWords = Math.floor((limit * 4) / FOLD_PROSE_CHARS_PER_WORD)
      expect(looksFoldDigestTruncated(proseOfWords(nearCapWords), limit)).toBe(true)
    },
  )

  it('small inputs floor at 200; larger inputs target 20% of their word count', () => {
    expect(foldDigestTargetWords(300, 4096)).toBe(200)
    expect(foldDigestTargetWords(1000, 4096)).toBe(200) // 1000*0.2=200, floor and ratio agree here
    expect(foldDigestTargetWords(3000, 4096)).toBe(600) // 3000*0.2=600, ratio binds
  })

  const seg = (id: string, words: number, kind: SegmentKind = 'continues'): FoldableSegment => ({
    id,
    kind,
    content: proseOfWords(words),
    coverageThroughIcPost: 1,
    coveragePageId: 'p1',
    seq: 0,
  })

  it('selectFoldBatch packs segments until the target would exceed one Editor call', () => {
    const batch = selectFoldBatch(
      Array.from({ length: 25 }, (_, i) => seg(`s${i}`, 500)),
      4096,
    )
    // maxTargetWords ≈ 1911 → at ratio 0.2, 19 × 500-word segments (target 1900) fit; the 20th
    // (target 2000) doesn't. Needs more segments than at the old 0.5 ratio to demonstrate the
    // cutoff at all, since a tighter ratio means more raw input fits under the same target cap.
    expect(batch.map((s) => s.id)).toEqual(Array.from({ length: 19 }, (_, i) => `s${i}`))
  })

  it('whatever batch is selected, the instructed target still fits one response', () => {
    const maxTargetWords = foldDigestTargetWords(Number.MAX_SAFE_INTEGER, 4096)
    for (const batch of [
      selectFoldBatch(
        Array.from({ length: 8 }, (_, i) => seg(`s${i}`, 500)),
        4096,
      ),
      selectFoldBatch([seg('a', 3000), seg('b', 3000)], 4096),
    ]) {
      const mergedWords = batch.reduce((n, s) => n + s.content.split(/\s+/).length, 0)
      expect(foldDigestTargetWords(mergedWords, 4096)).toBeLessThanOrEqual(maxTargetWords)
    }
  })

  // Regression context (2026-08-01, VM full-scale save): selectFoldBatch's old fallback
  // (`fold.slice(0, Math.min(2, fold.length))`) forced a minimum of 2 segments into a batch even
  // when the first alone was already too large to safely pair with a second — squeezing the
  // shared target down to maxTargetWords instead of each segment's normal ~50% ratio, and the
  // model blew past max_tokens every retry (batch selection is deterministic, so it never
  // recovered on its own). Never forcing a second segment in fixes it: the batch just stays at 1.
  it("doesn't force a second oversized segment into the batch", () => {
    // 5000+5000 words at ratio 0.2 -> target 2000, over maxTargetWords (1911); needs bigger
    // segments than at the old 0.5 ratio to still exceed the cap and demonstrate this.
    const batch = selectFoldBatch([seg('a', 5000), seg('b', 5000)], 4096)
    expect(batch.map((s) => s.id)).toEqual(['a'])
  })

  // The same old `< 2` fallback also rejected a fold set of exactly 1 segment outright (both here
  // and in selectFoldBatch's callers) — so once a prior fold left a single "deep past" digest with
  // no sibling to combine with yet, it could never be recompressed further, no matter how large it
  // grew relative to the soft cap. A batch of 1 is a valid recursive re-compression, not a no-op.
  it('folds a lone oversized segment on its own instead of refusing to act', () => {
    const lone = seg('deep-past', 3000)
    const recent = seg('recent', 100)
    const { fold } = selectFoldSet([lone, { ...recent, seq: 1 }])
    expect(fold.map((s) => s.id)).toEqual(['deep-past'])

    const batch = selectFoldBatch(fold, 4096)
    expect(batch.map((s) => s.id)).toEqual(['deep-past'])
  })
})

// Regression context (2026-08-01, VM story 019fa8c7): folding was re-merging an existing "deep
// past" fold row together with newly-eligible continues segments in one call every time, asking
// the model to re-derive the entire settled digest from scratch alongside the new material —
// which is why a 3-segment merge (a ~5000-token fold row + two small continues segments) blew
// past its instructed target and hit max_tokens. The fix: two independent tiers. Case 1 (append)
// only ever touches not-yet-folded segments; case 2 (shrink) only ever touches existing fold rows,
// and only once the fold tier alone has grown as large as the recent-detail tier.
describe('fold tier: append vs. shrink split', () => {
  const seg = (id: string, words: number, kind: SegmentKind, seq: number): FoldableSegment => ({
    id,
    kind,
    content: proseOfWords(words),
    coverageThroughIcPost: seq + 1,
    coveragePageId: `p${seq}`,
    seq,
  })

  // tokens ≈ words * FOLD_PROSE_CHARS_PER_WORD / CHARS_PER_TOKEN_ESTIMATE for proseOfWords' default
  // char width — inverting that gives the word count that lands a segment at a target token count.
  const wordsForTokens = (tokens: number): number =>
    Math.round((tokens * CHARS_PER_TOKEN_ESTIMATE) / FOLD_PROSE_CHARS_PER_WORD)

  it('selectFoldTierShrinkSet is empty when no fold row exists yet', () => {
    const segments = [seg('c0', 100, 'continues', 0), seg('c1', 100, 'continues', 1)]
    expect(selectFoldTierShrinkSet(segments)).toEqual([])
  })

  it('selectFoldTierShrinkSet is empty while the fold tier is under the recent-tier threshold', () => {
    const segments = [
      seg('fold0', wordsForTokens(FOLD_KEEP_RECENT_TOKENS - 200), 'fold', 0),
      seg('c1', 100, 'continues', 1),
    ]
    expect(selectFoldTierShrinkSet(segments)).toEqual([])
  })

  it('selectFoldTierShrinkSet returns fold rows, oldest first, once their total crosses threshold', () => {
    const segments = [
      seg('fold1', wordsForTokens(200), 'fold', 5),
      seg('fold0', wordsForTokens(FOLD_KEEP_RECENT_TOKENS + 200), 'fold', 0),
      seg('c2', 100, 'continues', 10),
    ]
    expect(selectFoldTierShrinkSet(segments).map((s) => s.id)).toEqual(['fold0', 'fold1'])
  })

  it('an existing fold row is never merged into a case-1 append batch alongside new material', () => {
    // Mirrors fold-worker.ts/index.ts's actual filtering: selectFoldSet finds everything outside
    // the recent window regardless of kind, and callers exclude kind='fold' before batching. The
    // recent-tail budget (FOLD_KEEP_RECENT_TOKENS) is deliberately blown past by 'recent' + 'c30'
    // alone so both non-fold segments land in the eligible prefix alongside the fold row.
    const segments = [
      seg('fold0', wordsForTokens(3000), 'fold', 0),
      seg('c29', 400, 'continues', 29),
      seg('c30', wordsForTokens(FOLD_KEEP_RECENT_TOKENS + 200), 'continues', 30),
      seg('recent', 100, 'continues', 31),
    ]
    const { fold: eligible, keep } = selectFoldSet(segments)
    expect(eligible.map((s) => s.id)).toEqual(['fold0', 'c29', 'c30'])
    expect(keep.map((s) => s.id)).toEqual(['recent'])

    const appendCandidates = eligible.filter((s) => s.kind !== 'fold')
    expect(appendCandidates.map((s) => s.id)).toEqual(['c29', 'c30'])

    const batch = selectFoldBatch(appendCandidates, 4096)
    expect(batch.some((s) => s.kind === 'fold')).toBe(false)
  })
})

// Regression context (2026-08-02, VM story 019fa8c7): a real fold call showed
// inputTokens=6379, outputTokens=2169 -- ~34% output/input, almost exactly the old
// FOLD_TARGET_RATIO (0.5) applied to the merged input. The model was obeying the instructed
// target; the target itself wasn't tight enough, and nothing tied the API's real maxTokens to it
// either -- every arm in the tuning A/B finished via finish_reason "stop", never actually cut off,
// because the call always used the full responseLimit regardless of what was asked for.
// foldCeilingTokens closes that gap: the API's real ceiling now tracks the instructed target.
describe('foldCeilingTokens', () => {
  it('computes a ceiling from the target, not the flat responseLimit', () => {
    const targetWords = 200
    const targetTokens = Math.ceil(
      (targetWords * FOLD_PROSE_CHARS_PER_WORD) / CHARS_PER_TOKEN_ESTIMATE,
    )
    const ceiling = foldCeilingTokens(targetWords, 4096)
    expect(ceiling).toBe(Math.ceil(targetTokens * FOLD_CEILING_MULTIPLIER))
    expect(ceiling).toBeLessThan(4096) // meaningfully tighter than the full model ceiling
  })

  it('never exceeds the model responseLimit even for a very large target', () => {
    expect(foldCeilingTokens(100_000, 4096)).toBe(4096)
  })

  it('gives a compliant response real headroom above the bare target', () => {
    // FOLD_CEILING_MULTIPLIER should leave room for a response that lands somewhat over target
    // without getting cut off -- otherwise a merely slightly-verbose (not runaway) response would
    // spuriously trip the truncation check.
    const targetWords = 500
    const targetTokens = Math.ceil(
      (targetWords * FOLD_PROSE_CHARS_PER_WORD) / CHARS_PER_TOKEN_ESTIMATE,
    )
    const ceiling = foldCeilingTokens(targetWords, 4096)
    expect(ceiling).toBeGreaterThan(targetTokens)
  })
})
