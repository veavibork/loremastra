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
  genExtract: string | null;
  compressMetrics: string | null;
}

export interface SummaryPage {
  entries: LogEntry[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

/** Compressed summaries and pending posts — most recent first. */
export function buildSummaryPage(
  db: Database.Database,
  logbookId: string,
  options: { offset?: number; limit?: number; includeHidden?: boolean; compressedOnly?: boolean } = {}
): SummaryPage {
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, Math.min(options.limit ?? 10_000, 10_000));
  const includeHidden = options.includeHidden ?? false;
  const compressedOnly = options.compressedOnly ?? false;

  const rows = buildLogView(db, logbookId)
    .filter((e) => (includeHidden || !e.hidden) && (compressedOnly ? e.genExtract != null : true))
    .reverse();

  const total = rows.length;
  const entries = rows.slice(offset, offset + limit);
  return {
    entries,
    total,
    offset,
    limit,
    hasMore: offset + entries.length < total,
  };
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
      genExtract: text?.genExtract ?? null,
      compressMetrics: text?.compressMetrics ?? null,
    });
    currentId = page.prevPageId;
  }

  return entries;
}
