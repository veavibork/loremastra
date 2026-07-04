import type Database from "better-sqlite3";
import type { PageRow } from "../db/page-store.js";
import { getText, type TextRow } from "../db/text-store.js";

export const ARCHIVE_BLOCK_SIZE = 10;

/** Pages with no canon prose that will not be filled by normal archive enqueue — skip when gathering members. */
export function isArchiveSkippablePage(page: PageRow, text: TextRow | null): boolean {
  if (page.broken) return true;
  if (!page.selectedTextId) return true;
  if (text && !text.genPackage?.trim()) return true;
  return false;
}


/** 1-based log post numbers in a fixed decad window with empty/skippable slots (skipped when gathering). */
export function proseEmptyInWindow(
  windowPages: PageRow[],
  db: Database.Database,
  globalStartIndex: number
): number[] {
  const empty: number[] = [];
  for (let i = 0; i < windowPages.length; i++) {
    const page = windowPages[i]!;
    const text = page.selectedTextId ? getText(db, page.selectedTextId) : null;
    if (!text?.genPackage?.trim() && isArchiveSkippablePage(page, text)) {
      empty.push(globalStartIndex + i + 1);
    }
  }
  return empty;
}

/** 1-based log post numbers in a fixed decad window that lack prose and are not skippable. */
export function proseMissingInWindow(
  windowPages: PageRow[],
  db: Database.Database,
  globalStartIndex: number
): number[] {
  const missing: number[] = [];
  for (let i = 0; i < windowPages.length; i++) {
    const page = windowPages[i]!;
    const text = page.selectedTextId ? getText(db, page.selectedTextId) : null;
    if (!text?.genPackage?.trim() && !isArchiveSkippablePage(page, text)) {
      missing.push(globalStartIndex + i + 1);
    }
  }
  return missing;
}

/** Collect the next N in-character posts with prose from startIndex, skipping stuck empty slots. */
export function gatherArchiveMembers(
  pages: PageRow[],
  startIndex: number,
  db: Database.Database
): { pages: PageRow[]; texts: TextRow[] } | null {
  const members: { page: PageRow; text: TextRow }[] = [];
  let i = startIndex;
  while (i < pages.length && members.length < ARCHIVE_BLOCK_SIZE) {
    const page = pages[i]!;
    const text = page.selectedTextId ? getText(db, page.selectedTextId) : null;
    if (text?.genPackage?.trim()) {
      members.push({ page, text });
    } else if (isArchiveSkippablePage(page, text)) {
      i++;
      continue;
    } else {
      return null;
    }
    i++;
  }
  if (members.length < ARCHIVE_BLOCK_SIZE) return null;
  return { pages: members.map((m) => m.page), texts: members.map((m) => m.text) };
}
