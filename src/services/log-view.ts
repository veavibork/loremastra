import type Database from "better-sqlite3";
import { findHeadPageId, getPage } from "../db/page-store.js";
import { getText, type TextRole } from "../db/text-store.js";

export interface LogEntry {
  pageId: string;
  textId: string | null;
  role: TextRole | "user";
  content: string | null;
  hidden: boolean;
  createdAt: string | null;
  genMetrics: string | null;
}

/** findHeadPageId is fork-aware (Milestone D); walking backward via prev_page_id from its result is always the correct active-path history regardless of forks, since prev_page_id is single/unambiguous going backward. */
export function buildLogView(db: Database.Database, logbookId: string): LogEntry[] {
  const entries: LogEntry[] = [];
  let currentId: string | null = findHeadPageId(db, logbookId);

  while (currentId) {
    const page = getPage(db, currentId);
    if (!page) break;
    const text = page.selectedTextId ? getText(db, page.selectedTextId) : null;
    entries.unshift({
      pageId: page.id,
      textId: text?.id ?? null,
      role: text?.role ?? "user",
      content: text?.genPackage ?? null,
      hidden: page.hidden,
      createdAt: text?.createdAt ?? null,
      genMetrics: text?.genMetrics ?? null,
    });
    currentId = page.prevPageId;
  }

  return entries;
}
