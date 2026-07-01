import type Database from "better-sqlite3";
import { newId } from "../uuid.js";
import { nowIso } from "./time.js";

export interface TagRow {
  id: string;
  bookId: string;
  name: string;
  worldbookPageId: string | null;
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
}

interface RawTagRow {
  id: string;
  book_id: string;
  name: string;
  worldbook_page_id: string | null;
  hidden: number;
  created_at: string;
  updated_at: string;
}

function mapTagRow(row: RawTagRow): TagRow {
  return {
    id: row.id,
    bookId: row.book_id,
    name: row.name,
    worldbookPageId: row.worldbook_page_id,
    hidden: !!row.hidden,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Doc requirement: tag names are alphabetic only, no punctuation/spaces/digits. */
export function isValidTagName(name: string): boolean {
  return /^[A-Za-z]+$/.test(name);
}

export function createTag(
  db: Database.Database,
  input: { bookId: string; name: string; worldbookPageId?: string | null }
): TagRow {
  if (!isValidTagName(input.name)) {
    throw new Error(`Invalid tag name "${input.name}": alphabetic characters only`);
  }
  const id = newId();
  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO tags (id, book_id, name, worldbook_page_id, hidden, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`
  ).run(id, input.bookId, input.name, input.worldbookPageId ?? null, createdAt, createdAt);
  return getTag(db, id)!;
}

export function getTag(db: Database.Database, id: string): TagRow | null {
  const row = db.prepare(`SELECT * FROM tags WHERE id = ?`).get(id) as RawTagRow | undefined;
  return row ? mapTagRow(row) : null;
}

export function listTags(db: Database.Database, bookId: string): TagRow[] {
  const rows = db
    .prepare(`SELECT * FROM tags WHERE book_id = ? ORDER BY name ASC`)
    .all(bookId) as RawTagRow[];
  return rows.map(mapTagRow);
}

export function renameTag(db: Database.Database, id: string, newName: string): TagRow {
  if (!isValidTagName(newName)) {
    throw new Error(`Invalid tag name "${newName}": alphabetic characters only`);
  }
  db.prepare(`UPDATE tags SET name = ?, updated_at = ? WHERE id = ?`).run(newName, nowIso(), id);
  return getTag(db, id)!;
}

/** Doc: delete is a toggle, not a real delete — consistent with nothing-is-deleted elsewhere in this schema. */
export function setTagHidden(db: Database.Database, id: string, hidden: boolean): void {
  db.prepare(`UPDATE tags SET hidden = ?, updated_at = ? WHERE id = ?`).run(hidden ? 1 : 0, nowIso(), id);
}

/** Attaches or detaches a tag from a worldbook entry's page (null = detach). One tag points at most one entry; one entry can have many tags. */
export function setTagWorldbookPage(db: Database.Database, id: string, worldbookPageId: string | null): void {
  db.prepare(`UPDATE tags SET worldbook_page_id = ?, updated_at = ? WHERE id = ?`).run(worldbookPageId, nowIso(), id);
}
