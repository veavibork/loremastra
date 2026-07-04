import type Database from "better-sqlite3";
import { listChronologicalPages, setPageHidden } from "../db/page-store.js";

/**
 * Hides every setup-phase page (everything before the kickoff page) —
 * loremaster.md's Kickoff steps 4-5. Per-post compression is disabled; hidden
 * setup pages are excluded from Author assembly via the hidden flag.
 */
export function finalizeSetup(db: Database.Database, logbookId: string, kickoffPageId: string): void {
  const pages = listChronologicalPages(db, logbookId);
  for (const page of pages) {
    if (page.id === kickoffPageId) break;
    setPageHidden(db, page.id, true);
  }
}
