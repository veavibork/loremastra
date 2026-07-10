import type Database from "better-sqlite3";
import { createPageWithText, createRetryText } from "./content-store.js";
import { getPage, setPageHidden, listPagesForBook } from "./page-store.js";
import { getText, type TextRow } from "./text-store.js";

export type WorldbookEntryType = "content" | "roster" | "memory";

export interface WorldbookEntry {
  pageId: string;
  bookId: string;
  entryType: WorldbookEntryType;
  hidden: boolean;
  broken: boolean;
  createdAt: string;
  content: string;
  currentTextId: string;
}

interface RawWorldbookEntryRow {
  page_id: string;
  entry_type: WorldbookEntryType;
}

const WORLDBOOK_CLOSE_TAG: Record<WorldbookEntryType, string> = {
  content: "[/CONTENT]",
  roster: "[/ROSTER]",
  memory: "[/MEMORY]",
};

/** Stored entries are raw field content — bracket tags are added only when assembling prompts. */
export function normalizeWorldbookStoredContent(content: string, entryType: WorldbookEntryType): string {
  let text = content.trim();
  for (let i = 0; i < 5; i++) {
    const next = text
      .replace(/^Entry type:\s*(CONTENT|ROSTER|MEMORY)\s*\n+/i, "")
      .replace(/^Worldbook entry to compact:\s*\n+/i, "")
      .replace(/^\[(CONTENT|ROSTER|MEMORY)\]\s*\n?/i, "")
      .trim();
    if (next === text) break;
    text = next;
  }
  const close = WORLDBOOK_CLOSE_TAG[entryType];
  if (text.toUpperCase().endsWith(close.toUpperCase())) {
    text = text.slice(0, -close.length).trimEnd();
  }
  return text;
}

function toEntry(row: RawWorldbookEntryRow, page: { bookId: string; hidden: boolean; broken: boolean; createdAt: string }, text: TextRow): WorldbookEntry {
  return {
    pageId: row.page_id,
    bookId: page.bookId,
    entryType: row.entry_type,
    hidden: page.hidden,
    broken: page.broken,
    createdAt: page.createdAt,
    content: normalizeWorldbookStoredContent(text.genPackage ?? "", row.entry_type),
    currentTextId: text.id,
  };
}

export function createWorldbookEntry(
  db: Database.Database,
  input: { bookId: string; entryType: WorldbookEntryType; content: string }
): WorldbookEntry {
  const run = db.transaction(() => {
    const { page, text } = createPageWithText(db, {
      bookId: input.bookId,
      role: "system",
      genPackage: normalizeWorldbookStoredContent(input.content, input.entryType),
    });
    db.prepare(`INSERT INTO worldbook_entry (page_id, entry_type) VALUES (?, ?)`).run(page.id, input.entryType);
    return { page, text };
  });
  const { page } = run();
  return getWorldbookEntry(db, page.id)!;
}

export function getWorldbookEntry(db: Database.Database, pageId: string): WorldbookEntry | null {
  const row = db.prepare(`SELECT * FROM worldbook_entry WHERE page_id = ?`).get(pageId) as RawWorldbookEntryRow | undefined;
  if (!row) return null;
  const page = getPage(db, pageId);
  if (!page || !page.selectedTextId) return null;
  const text = getText(db, page.selectedTextId);
  if (!text) return null;
  return toEntry(row, page, text);
}

/** Chronological (oldest first), matching listPagesForBook's own page order. */
export function listWorldbookEntries(
  db: Database.Database,
  worldbookBookId: string,
  opts?: { includeHidden?: boolean }
): WorldbookEntry[] {
  const pages = listPagesForBook(db, worldbookBookId);
  const entries: WorldbookEntry[] = [];
  for (const page of pages) {
    if (!opts?.includeHidden && page.hidden) continue;
    const entry = getWorldbookEntry(db, page.id);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * CONTENT entries always-inject into every Author prompt, in creation order -- unlike
 * ROSTER/MEMORY they're never a hard singleton (see EDITOR_UPDATE_PROMPT: later CONTENT
 * entries are deltas/contradictions to earlier ones, read one after another).
 */
export function listContentEntries(db: Database.Database, worldbookBookId: string): WorldbookEntry[] {
  return listWorldbookEntries(db, worldbookBookId).filter((e) => e.entryType === "content");
}

/** Edit = new text version under the same page (createRetryText), same convention posts already use -- gives worldbook version history for free. */
export function updateWorldbookEntry(db: Database.Database, pageId: string, input: { content?: string }): WorldbookEntry {
  const existing = getWorldbookEntry(db, pageId);
  if (!existing) throw new Error(`Worldbook entry ${pageId} not found`);

  if (typeof input.content === "string") {
    createRetryText(db, {
      pageId,
      priorTextId: existing.currentTextId,
      role: "system",
      genPackage: normalizeWorldbookStoredContent(input.content, existing.entryType),
    });
  }
  return getWorldbookEntry(db, pageId)!;
}

/** Doc says "delete" for worldbook entries, but nothing is ever hard-deleted elsewhere in this schema -- same hide toggle as pages/tags, consistent with worldbook versioning (history stays recoverable). */
export function setWorldbookEntryHidden(db: Database.Database, pageId: string, hidden: boolean): void {
  setPageHidden(db, pageId, hidden);
}
