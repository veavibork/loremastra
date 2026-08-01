import type Database from 'better-sqlite3'
import { completeChatWithMeta } from '../../inference/featherless.js'
import { createLogger } from '../../inference/outbound-telemetry.js'

/** Large merged segments can legitimately take several minutes — still bounded. */
export const STORY_TO_DATE_FOLD_TIMEOUT_MS = 10 * 60_000
import {
  listStoryToDateSegments,
  getStoryToDateSegment,
  createStoryToDateSegment,
  fillStoryToDateSegment,
  deleteStoryToDateSegment,
} from '../../db/story-to-date-store.js'
import { getAgentProfile } from '../agent-config.js'
import {
  buildFoldSystem,
  selectFoldSet,
  selectFoldBatch,
  selectFoldTierShrinkSet,
  estimateTokens,
  foldDigestTargetWords,
  foldWordCount,
  looksFoldDigestTruncated,
  type FoldableSegment,
} from './engine.js'

/**
 * Feature A: keep total STORY TO DATE memory bounded as a story runs indefinitely, via two
 * distinct operations sharing this one job type:
 *
 * Case 1 (append — the common path): segments that have aged out of the recent-detail window
 * (selectFoldSet) get condensed into a brand-new kind='fold' row, positioned right after the
 * existing fold tier (see the seq-reuse comment below). Existing fold-tier rows are never part of
 * this call — the model only ever compresses not-yet-folded material, so it never has to
 * re-derive content that's already settled.
 *
 * Case 2 (shrink the fold tier itself — rare, only tried once case 1 has nothing new to absorb):
 * once the fold tier's own accumulated size rivals the recent-detail tier (selectFoldTierShrinkSet),
 * its oldest rows get recompressed among themselves, further shrinking the deep past without ever
 * touching not-yet-folded material.
 *
 * Both cases execute identically once a batch is chosen: merge the batch's content, ask the
 * Editor to condense it, replace the whole batch with one new fold row.
 */
export async function executeStoryToDateFoldJob(
  db: Database.Database,
  userId: string,
  logbookId: string,
  targetSegmentId: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<void> {
  const rows = listStoryToDateSegments(db, logbookId).filter((s) => s.content?.trim() && !s.broken)
  const segments: FoldableSegment[] = rows.map((s) => ({
    id: s.id,
    kind: s.kind,
    content: s.content!.trim(),
    coverageThroughIcPost: s.coverageThroughIcPost,
    coveragePageId: s.coveragePageId,
    seq: s.seq,
  }))

  const editor = getAgentProfile(userId, 'editor')

  const { fold: eligible } = selectFoldSet(segments)
  const appendCandidates = eligible.filter((s) => s.kind !== 'fold')
  let batch = selectFoldBatch(appendCandidates, editor.responseLimit)
  if (!batch.length) {
    batch = selectFoldBatch(selectFoldTierShrinkSet(segments), editor.responseLimit)
  }

  // Deterministic recheck — state may have shifted since enqueue (an edit invalidated segments,
  // or a competing fold already ran). Only proceed if the target is still the oldest eligible member.
  if (!batch.length || batch[0]!.id !== targetSegmentId) return // no-op: nothing worth folding

  const last = batch[batch.length - 1]!
  if (last.coverageThroughIcPost == null || !last.coveragePageId) return // can't set digest coverage

  const merged = batch.map((s) => s.content).join('\n\n')
  const foldTokens = estimateTokens(merged)
  const targetWords = foldDigestTargetWords(foldWordCount(merged), editor.responseLimit)
  const messages = [
    { role: 'system' as const, content: buildFoldSystem(targetWords) },
    { role: 'user' as const, content: `Older memory to condense (chronological):\n\n${merged}` },
  ]

  const { content, finishReason } = await completeChatWithMeta(editor, apiKey, messages, {
    maxTokens: editor.responseLimit,
    timeoutMs: STORY_TO_DATE_FOLD_TIMEOUT_MS,
    signal,
  })
  const digest = content.trim()
  if (!digest) throw new Error('fold produced empty digest')
  const foldLog = createLogger({ jobType: 'story-to-date-fold' })
  const foldLogDetail = {
    targetSegmentId,
    batchIds: batch.map((s) => s.id),
    batchSeqs: batch.map((s) => s.seq),
    model: editor.model,
    finishReason,
    targetWords,
    mergedInputTokens: foldTokens,
    digestEstimatedTokens: estimateTokens(digest),
    digestPreview: digest.slice(0, 1500),
  }
  // finish_reason is ground truth for a max_tokens cutoff; the length estimate is only a
  // backstop for providers that omit it (a compliant target-length digest sits well under it).
  if (finishReason === 'length') {
    foldLog.warn('fold digest truncated at Editor max_tokens', foldLogDetail)
    throw new Error(
      `fold digest truncated at Editor max_tokens (${editor.responseLimit}) — refusing to apply`,
    )
  }
  if (finishReason === null && looksFoldDigestTruncated(digest, editor.responseLimit)) {
    foldLog.warn('fold digest likely truncated at Editor max_tokens', foldLogDetail)
    throw new Error(
      `fold digest likely truncated at Editor max_tokens (${editor.responseLimit}) — refusing to apply`,
    )
  }
  // Guard against a non-compressing result — if the model returned something as large as the input,
  // applying it would churn without shrinking anything. Leave the segments as they are.
  if (estimateTokens(digest) >= foldTokens) {
    foldLog.warn(
      'fold digest did not shrink relative to input — leaving segments unchanged',
      foldLogDetail,
    )
    return
  }

  // Late safety check — the LLM call can take several minutes; reconfirm every batch member is
  // still present and unbroken before replacing them (a concurrent edit could have invalidated one).
  for (const seg of batch) {
    const row = getStoryToDateSegment(db, seg.id)
    if (!row || row.broken) return
  }

  for (const seg of batch) {
    deleteStoryToDateSegment(db, seg.id)
  }
  // New fold row takes the oldest folded segment's seq — that's what keeps it sorted correctly
  // relative to any earlier fold-tier row (always lower seq) and any remaining segment (always
  // higher seq), without needing fractional/UUID ordering keys. Safe because batches are always a
  // contiguous, oldest-first prefix of what's currently eligible (see engine.ts's selectFoldSet
  // doc comment) — nothing ever needs to be inserted between two untouched rows.
  const newSegment = createStoryToDateSegment(db, {
    bookId: logbookId,
    kind: 'fold',
    seq: batch[0]!.seq,
  })
  fillStoryToDateSegment(db, newSegment.id, {
    content: digest,
    coverageThroughIcPost: last.coverageThroughIcPost,
    coveragePageId: last.coveragePageId,
    inputCeilingIcPost: last.coverageThroughIcPost,
    inputCeilingPageId: last.coveragePageId,
  })
}
