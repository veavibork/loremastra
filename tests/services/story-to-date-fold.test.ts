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
  foldDigestTargetWords,
  looksFoldDigestTruncated,
  selectFoldBatch,
  estimateTokens,
  FOLD_MAX_OUTPUT_TOKEN_RATIO,
  FOLD_PROSE_CHARS_PER_WORD,
  type FoldableSegment,
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

  it('small inputs target half their word count, floored at 200', () => {
    expect(foldDigestTargetWords(300, 4096)).toBe(200)
    expect(foldDigestTargetWords(1000, 4096)).toBe(500)
  })

  const seg = (id: string, words: number): FoldableSegment => ({
    id,
    content: proseOfWords(words),
    coverageThroughIcPost: 1,
    coveragePageId: 'p1',
    seq: 0,
  })

  it('selectFoldBatch packs segments until the target would exceed one Editor call', () => {
    const batch = selectFoldBatch(
      Array.from({ length: 8 }, (_, i) => seg(`s${i}`, 500)),
      4096,
    )
    // maxTargetWords ≈ 1911 → 7 × 500-word segments (target 1750) fit; the 8th (target 2000) doesn't.
    expect(batch.map((s) => s.id)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's6'])
  })

  it('whatever batch is selected, the instructed target still fits one response', () => {
    const maxTargetWords = foldDigestTargetWords(Number.MAX_SAFE_INTEGER, 4096)
    // Oversized pair — batching can't shrink below 2, so the instruction clamp is what saves it.
    const batch = selectFoldBatch([seg('a', 3000), seg('b', 3000)], 4096)
    expect(batch).toHaveLength(2)
    const mergedWords = batch.reduce((n, s) => n + s.content.split(/\s+/).length, 0)
    expect(foldDigestTargetWords(mergedWords, 4096)).toBeLessThanOrEqual(maxTargetWords)
  })
})
