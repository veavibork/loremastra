import type Database from "better-sqlite3";
import { listChronologicalPages, setPageHidden } from "../db/page-store.js";
import { getText } from "../db/text-store.js";
import { createJob, hasActiveJobForText } from "../db/job-store.js";

/**
 * Hides every setup-phase page (everything before the kickoff page) and
 * queues compression for any of their texts not already compressed —
 * loremaster.md's Kickoff steps 4-5. Steps 6-7 (archiving the setup
 * sequence and the kickoff post as their own blocks) are deliberately not
 * implemented: the instant these pages are hidden they're excluded from
 * prompt assembly entirely (assembleAuthorPrompt filters on !hidden before
 * it ever looks at archives), so those two archive blocks would only ever
 * serve a future Logs/Debug UI that doesn't exist yet. Noted in
 * docs/roadmap.md as a deliberate scope trim, not an oversight.
 */
export function finalizeSetup(db: Database.Database, logbookId: string, kickoffPageId: string): void {
  const pages = listChronologicalPages(db, logbookId);
  for (const page of pages) {
    if (page.id === kickoffPageId) break;
    setPageHidden(db, page.id, true);

    if (!page.selectedTextId) continue;
    const text = getText(db, page.selectedTextId);
    if (!text || text.genExtract !== null) continue;
    if (hasActiveJobForText(db, text.id, "compress")) continue;
    createJob(db, { targetTextId: text.id, jobType: "compress", priority: 1 });
  }
}
