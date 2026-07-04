import type Database from "better-sqlite3";
import {
  deleteStoryToDateSegment,
  deleteStoryToDateSegmentsFromSeq,
  getStoryToDateSegment,
  setStoryToDateSegmentCoverage,
} from "../db/story-to-date-store.js";
import { resolvePageIdForChainPost } from "./post-index.js";
import {
  enqueueEligibleStoryToDateJob,
  enqueuePendingStoryToDateJobs,
} from "./story-to-date.js";

export function removeStoryToDateSegment(
  db: Database.Database,
  userId: string,
  logbookId: string,
  storyId: string,
  segmentId: string,
  options: { deleteLaterSegments?: boolean } = {}
): void {
  const segment = getStoryToDateSegment(db, segmentId);
  if (!segment || segment.bookId !== logbookId) throw new Error("segment not found");

  if (options.deleteLaterSegments) {
    deleteStoryToDateSegmentsFromSeq(db, logbookId, segment.seq);
  } else {
    deleteStoryToDateSegment(db, segmentId);
  }

  enqueueEligibleStoryToDateJob(db, userId, logbookId, storyId);
  enqueuePendingStoryToDateJobs(db, userId, logbookId);
}

export function updateStoryToDateCoverageThroughPost(
  db: Database.Database,
  segmentId: string,
  logbookId: string,
  coverageThroughIcPost: number
): void {
  if (!Number.isFinite(coverageThroughIcPost) || coverageThroughIcPost <= 0) {
    throw new Error("coverageThroughIcPost must be a positive number");
  }
  const segment = getStoryToDateSegment(db, segmentId);
  if (!segment || segment.bookId !== logbookId) throw new Error("segment not found");
  const pageId = resolvePageIdForChainPost(db, logbookId, coverageThroughIcPost);
  if (!pageId) throw new Error(`no page for chain post ${coverageThroughIcPost}`);
  setStoryToDateSegmentCoverage(db, segmentId, {
    coverageThroughIcPost,
    coveragePageId: pageId,
  });
}
