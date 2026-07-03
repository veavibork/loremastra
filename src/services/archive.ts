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
import { createJob } from "../db/job-store.js";
import { getAgentProfile } from "./agent-config.js";
import { postNeedsCompress } from "./content-stamp.js";

// Doc + lorepebble-proven design: overlapping 10-post windows, 50% overlap.
const ARCHIVE_BLOCK_SIZE = 10;
const ARCHIVE_BLOCK_STEP = 5;

/**
 * State-based, not position-based, per the doc: a block is created whenever
 * a complete window of fully-compressed posts exists with no block covering
 * that start point yet. Handles rewrites/undos/branches correctly because it
 * checks the precondition rather than counting rows.
 */
export function enqueueEligibleArchiveBlocks(db: Database.Database, userId: string, logbookId: string): void {
  const pages = listChronologicalPages(db, logbookId).filter((p) => !p.hidden);
  const existingStarts = new Set(listArchivesForBook(db, logbookId).map((a) => a.startPageId));

  for (let start = 0; start + ARCHIVE_BLOCK_SIZE <= pages.length; start += ARCHIVE_BLOCK_STEP) {
    const windowPages = pages.slice(start, start + ARCHIVE_BLOCK_SIZE);
    const startPage = windowPages[0];
    if (existingStarts.has(startPage.id)) continue;

    const windowTexts = windowPages.map((p) => (p.selectedTextId ? getText(db, p.selectedTextId) : null));
    const allCompressed = windowPages.every((page, i) => {
      const text = windowTexts[i];
      return text?.genPackage && !postNeedsCompress(page, text);
    });
    if (!allCompressed) continue;

    const endPage = windowPages[windowPages.length - 1];
    const archive = createArchive(db, { bookId: logbookId, startPageId: startPage.id, endPageId: endPage.id });
    for (const text of windowTexts) {
      if (text) addArchiveMember(db, archive.id, text.id, false); // ownership computed separately, across all overlapping blocks
    }
    // Worker tier (KAI/lorepebble) — editor was 3+ min/block on full-prose archive prompts.
    createJob(db, {
      targetArchiveId: archive.id,
      jobType: "archive",
      slotCost: getAgentProfile(userId, "worker").concurrencyCost,
      priority: 5,
    });
  }

  recomputeArchiveOwnership(db, logbookId, pages);
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
      return b.startIdx - a.startIdx; // tie -> more recent block wins
    });

    const text = page.selectedTextId ? getText(db, page.selectedTextId) : null;
    if (!text) continue;
    for (const candidate of candidates) {
      setArchiveMemberOwner(db, candidate.archive.id, text.id, candidate === candidates[0]);
    }
  }
}
