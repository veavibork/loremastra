import type Database from "better-sqlite3";
import { listChronologicalPages, type PageRow } from "../db/page-store.js";
import { getText } from "../db/text-store.js";
import {
  createArchive,
  addArchiveMember,
  setArchiveMemberOwner,
  listArchivesForBook,
  type ArchiveRow,
} from "../db/archive-store.js";
import { createJob, hasActiveJobForArchive } from "../db/job-store.js";
import { getAgentProfile } from "./agent-config.js";

// Doc + lorepebble-proven design: overlapping 10-post windows, 50% overlap.
const ARCHIVE_BLOCK_SIZE = 10;
const ARCHIVE_BLOCK_STEP = 5;

/**
 * State-based, not position-based: a block is created whenever a complete window of
 * posts with prose exists with no block covering that start point yet.
 */
export function enqueueEligibleArchiveBlocks(db: Database.Database, userId: string, logbookId: string): void {
  const pages = listChronologicalPages(db, logbookId).filter((p) => !p.hidden);
  const existingStarts = new Set(listArchivesForBook(db, logbookId).map((a) => a.startPageId));

  for (let start = 0; start + ARCHIVE_BLOCK_SIZE <= pages.length; start += ARCHIVE_BLOCK_STEP) {
    const windowPages = pages.slice(start, start + ARCHIVE_BLOCK_SIZE);
    const startPage = windowPages[0];
    if (existingStarts.has(startPage.id)) continue;

    const windowTexts = windowPages.map((p) => (p.selectedTextId ? getText(db, p.selectedTextId) : null));
    const allHaveProse = windowPages.every((_, i) => !!windowTexts[i]?.genPackage?.trim());
    if (!allHaveProse) continue;

    const endPage = windowPages[windowPages.length - 1];
    const archive = createArchive(db, { bookId: logbookId, startPageId: startPage.id, endPageId: endPage.id });
    for (const text of windowTexts) {
      if (text) addArchiveMember(db, archive.id, text.id, false);
    }
    createArchiveJob(db, userId, archive.id);
  }

  recomputeArchiveOwnership(db, logbookId, pages);
  enqueuePendingArchiveJobs(db, userId, logbookId);
}

/** Re-queue archive jobs for blocks that exist but never received a summary. */
export function enqueuePendingArchiveJobs(db: Database.Database, userId: string, logbookId: string): number {
  let enqueued = 0;
  for (const archive of listArchivesForBook(db, logbookId)) {
    if (archive.summary?.trim() || archive.broken) continue;
    if (hasActiveJobForArchive(db, archive.id, "archive")) continue;
    createArchiveJob(db, userId, archive.id);
    enqueued++;
  }
  return enqueued;
}

function createArchiveJob(db: Database.Database, userId: string, archiveId: string): void {
  createJob(db, {
    targetArchiveId: archiveId,
    jobType: "archive",
    slotCost: getAgentProfile(userId, "editor").concurrencyCost,
    priority: 5,
  });
}

/**
 * Each post is "owned" by exactly one of the (possibly several) overlapping
 * blocks it belongs to — the one whose midpoint it's closest to, ties going
 * to the more recent block. Ownership decides which single archive
 * represents a post when the log collapses it during prompt assembly.
 */
function recomputeArchiveOwnership(db: Database.Database, logbookId: string, pages: PageRow[]): void {
  const positionOf = new Map(pages.map((p, i) => [p.id, i]));
  const blocks = listArchivesForBook(db, logbookId)
    .map((archive) => {
      const startIdx = positionOf.get(archive.startPageId);
      const endIdx = positionOf.get(archive.endPageId);
      if (startIdx == null || endIdx == null) return null;
      return { archive, startIdx, endIdx, midpoint: (startIdx + endIdx) / 2 };
    })
    .filter((b): b is { archive: ArchiveRow; startIdx: number; endIdx: number; midpoint: number } => b !== null);

  for (const page of pages) {
    const idx = positionOf.get(page.id)!;
    const candidates = blocks.filter((b) => idx >= b.startIdx && idx <= b.endIdx);
    if (candidates.length === 0) continue;

    candidates.sort((a, b) => {
      const distanceDiff = Math.abs(idx - a.midpoint) - Math.abs(idx - b.midpoint);
      if (distanceDiff !== 0) return distanceDiff;
      return b.startIdx - a.startIdx;
    });

    const text = page.selectedTextId ? getText(db, page.selectedTextId) : null;
    if (!text) continue;
    for (const candidate of candidates) {
      setArchiveMemberOwner(db, candidate.archive.id, text.id, candidate === candidates[0]);
    }
  }
}
