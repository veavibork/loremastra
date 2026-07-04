import type Database from "better-sqlite3";
import { getBookByType, getTagScopeBookId } from "../db/book-store.js";
import { deleteArchive, listArchivesForBook, syncArchiveMembersForPage } from "../db/archive-store.js";
import {
  cancelPendingJobsForArchive,
} from "../db/job-store.js";
import { getPage, listChronologicalPages, setMemoryContentStamp } from "../db/page-store.js";
import { getText, setTextBroken } from "../db/text-store.js";
import { computeTextContentStamp } from "./content-stamp.js";
import { enqueueEligibleArchiveBlocks } from "./archive.js";
import { indexTextAgainstAllTags } from "./tag-index.js";

export { computeTextContentStamp, postNeedsCompress } from "./content-stamp.js";

/** Called when a compress job finishes successfully for this page/text pair. */
export function markCompressValid(db: Database.Database, pageId: string, textId: string): void {
  const text = getText(db, textId);
  const stamp = computeTextContentStamp(text);
  if (!stamp) return;
  setMemoryContentStamp(db, pageId, stamp);
  setTextBroken(db, textId, false);
}

/**
 * Deletes archive blocks that are off the active page chain or overlap a changed page,
 * then lets enqueueEligibleArchiveBlocks recreate them once prose preconditions hold.
 */
export function invalidateArchivesForPage(
  db: Database.Database,
  userId: string,
  logbookId: string,
  pageId: string
): void {
  const pages = listChronologicalPages(db, logbookId).filter((p) => !p.hidden);
  const pageIndex = pages.findIndex((p) => p.id === pageId);
  const activeIds = new Set(pages.map((p) => p.id));

  for (const archive of listArchivesForBook(db, logbookId)) {
    const onChain = activeIds.has(archive.startPageId) && activeIds.has(archive.endPageId);
    if (!onChain) {
      cancelPendingJobsForArchive(db, archive.id);
      deleteArchive(db, archive.id);
      continue;
    }
    if (pageIndex < 0) continue;

    const startIdx = pages.findIndex((p) => p.id === archive.startPageId);
    const endIdx = pages.findIndex((p) => p.id === archive.endPageId);
    if (pageIndex >= startIdx && pageIndex <= endIdx) {
      cancelPendingJobsForArchive(db, archive.id);
      deleteArchive(db, archive.id);
    }
  }

  enqueueEligibleArchiveBlocks(db, userId, logbookId);
}

/**
 * After edit, retry, or undo/redo changes which text is canonical on a page: sync archive
 * membership, drop stale archive blocks, re-index tags, and queue archive jobs.
 */
export function onCanonicalTextChanged(
  db: Database.Database,
  userId: string,
  logbookId: string,
  pageId: string
): void {
  const page = getPage(db, pageId);
  if (!page) return;
  const text = page.selectedTextId ? getText(db, page.selectedTextId) : null;
  if (!text?.genPackage?.trim()) return;

  syncArchiveMembersForPage(db, pageId, text.id);
  invalidateArchivesForPage(db, userId, logbookId, pageId);

  const tagScopeBookId = getTagScopeBookId(db, logbookId);
  indexTextAgainstAllTags(db, tagScopeBookId, text.id);

  const stamp = computeTextContentStamp(text);
  if (stamp) {
    setMemoryContentStamp(db, pageId, stamp);
    setTextBroken(db, text.id, false);
  }
}

/** Drop archive blocks whose page range is no longer on the active chain (e.g. after fork truncate). */
export function pruneArchivesOffActiveChain(db: Database.Database, userId: string, logbookId: string): void {
  const pages = listChronologicalPages(db, logbookId).filter((p) => !p.hidden);
  const activeIds = new Set(pages.map((p) => p.id));

  for (const archive of listArchivesForBook(db, logbookId)) {
    if (!activeIds.has(archive.startPageId) || !activeIds.has(archive.endPageId)) {
      cancelPendingJobsForArchive(db, archive.id);
      deleteArchive(db, archive.id);
    }
  }

  enqueueEligibleArchiveBlocks(db, userId, logbookId);
}

/** Convenience wrapper when only logbook id is known from story db. */
export function onCanonicalTextChangedForStory(
  db: Database.Database,
  userId: string,
  pageId: string
): void {
  const logbook = getBookByType(db, "logbook");
  if (!logbook) return;
  onCanonicalTextChanged(db, userId, logbook.id, pageId);
}
