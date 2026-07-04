import type Database from "better-sqlite3";
import { listChronologicalPages, setPageHidden } from "../db/page-store.js";

/** First visible page on the active log chain — IC memory and post numbering start here. */
export function resolveIcStartPageId(db: Database.Database, logbookId: string): string | null {
  for (const page of listChronologicalPages(db, logbookId)) {
    if (!page.hidden) return page.id;
  }
  return null;
}

export function isOpeningPostPage(db: Database.Database, logbookId: string, pageId: string): boolean {
  const startId = resolveIcStartPageId(db, logbookId);
  return startId != null && startId === pageId;
}

/** Hides every setup-phase page (everything before the opening IC page). */
export function finalizeSetup(db: Database.Database, logbookId: string, openingPageId: string): void {
  for (const page of listChronologicalPages(db, logbookId)) {
    if (page.id === openingPageId) break;
    setPageHidden(db, page.id, true);
  }
}
