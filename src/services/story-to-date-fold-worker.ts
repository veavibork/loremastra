import type Database from "better-sqlite3";
import { completeChat } from "../inference/featherless.js";

/** Large merged segments can legitimately take several minutes — still bounded. */
export const STORY_TO_DATE_FOLD_TIMEOUT_MS = 10 * 60_000;
import {
  listStoryToDateSegments,
  getStoryToDateSegment,
  setStoryToDateSegmentContent,
  setStoryToDateSegmentCoverage,
  setStoryToDateSegmentName,
  deleteStoryToDateSegment,
} from "../db/story-to-date-store.js";
import { getAgentProfile } from "./agent-config.js";
import {
  buildFoldSystem,
  selectFoldSet,
  estimateTokens,
  FOLD_TARGET_RATIO,
  type FoldableSegment,
} from "./story-to-date-corpus.js";

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Feature A: fold the oldest STORY TO DATE segments into a single "deep past" digest so total
 * memory stays bounded as a story runs indefinitely. The job targets the oldest segment (seq 0);
 * that segment is overwritten with the digest and its coverage extended to the end of the folded
 * span, while the other folded segments are deleted. Recent segments are untouched, so the forward
 * compression pipeline (which resumes from the newest segment's coverage) is unaffected.
 */
export async function executeStoryToDateFoldJob(
  db: Database.Database,
  userId: string,
  logbookId: string,
  targetSegmentId: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<void> {
  const rows = listStoryToDateSegments(db, logbookId).filter((s) => s.content?.trim() && !s.broken);
  const segments: FoldableSegment[] = rows.map((s) => ({
    id: s.id,
    content: s.content!.trim(),
    coverageThroughIcPost: s.coverageThroughIcPost,
    coveragePageId: s.coveragePageId,
    seq: s.seq,
  }));

  const { fold } = selectFoldSet(segments);

  // Deterministic recheck — state may have shifted since enqueue (an edit invalidated segments,
  // or a competing fold already ran). Only proceed if the target is still the oldest fold member.
  if (fold.length < 2 || fold[0]!.id !== targetSegmentId) return; // no-op: nothing worth folding

  const last = fold[fold.length - 1]!;
  if (last.coverageThroughIcPost == null || !last.coveragePageId) return; // can't set digest coverage

  const merged = fold.map((s) => s.content).join("\n\n");
  const foldTokens = estimateTokens(merged);
  const targetWords = Math.max(200, Math.round(wordCount(merged) * FOLD_TARGET_RATIO));

  const editor = getAgentProfile(userId, "editor");
  const messages = [
    { role: "system" as const, content: buildFoldSystem(targetWords) },
    { role: "user" as const, content: `Older memory to condense (chronological):\n\n${merged}` },
  ];

  const digest = (
    await completeChat(editor, apiKey, messages, {
      maxTokens: editor.responseLimit,
      timeoutMs: STORY_TO_DATE_FOLD_TIMEOUT_MS,
      signal,
    })
  ).trim();
  if (!digest) throw new Error("fold produced empty digest");
  // Guard against a non-compressing result — if the model returned something as large as the input,
  // applying it would churn without shrinking anything. Leave the segments as they are.
  if (estimateTokens(digest) >= foldTokens) return;

  const target = getStoryToDateSegment(db, targetSegmentId);
  if (!target || target.broken) return;

  setStoryToDateSegmentContent(db, targetSegmentId, digest);
  setStoryToDateSegmentCoverage(db, targetSegmentId, {
    coverageThroughIcPost: last.coverageThroughIcPost,
    coveragePageId: last.coveragePageId,
  });
  // The digest now spans many scenes; its old single-scene name no longer fits (Archives display only).
  setStoryToDateSegmentName(db, targetSegmentId, "");

  for (const seg of fold.slice(1)) {
    deleteStoryToDateSegment(db, seg.id);
  }
}
