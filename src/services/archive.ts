import type Database from "better-sqlite3";
import { listChronologicalPages, type PageRow } from "../db/page-store.js";
import { getText } from "../db/text-store.js";
import {
  createArchive,
  addArchiveMember,
  setArchiveMemberOwner,
  listArchivesForBook,
  listMemberTextIds,
} from "../db/archive-store.js";
import { createJob, hasActiveJobForArchive } from "../db/job-store.js";
import { getAgentProfile } from "./agent-config.js";

// Non-overlapping decads: posts 1–10, 11–20, 21–30, … (Proposal A — no tag-promotion overlap needed).
const ARCHIVE_BLOCK_SIZE = 10;
const ARCHIVE_BLOCK_STEP = 10;

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
 * With non-overlapping blocks each post belongs to at most one archive — mark all members owner.
 */
function recomputeArchiveOwnership(db: Database.Database, logbookId: string, pages: PageRow[]): void {
  const positionOf = new Map(pages.map((p, i) => [p.id, i]));

  for (const archive of listArchivesForBook(db, logbookId)) {
    const startIdx = positionOf.get(archive.startPageId);
    const endIdx = positionOf.get(archive.endPageId);
    if (startIdx == null || endIdx == null) continue;

    for (const textId of listMemberTextIds(db, archive.id)) {
      setArchiveMemberOwner(db, archive.id, textId, true);
    }
  }
}
