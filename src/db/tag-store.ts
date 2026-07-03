import type Database from "better-sqlite3";
import { newId } from "../uuid.js";
import { nowIso } from "./time.js";

export interface TagRow {
  id: string;
  bookId: string;
  name: string;
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
}

interface RawTagRow {
  id: string;
  book_id: string;
  name: string;
  hidden: number;
  created_at: string;
  updated_at: string;
}

function mapTagRow(row: RawTagRow): TagRow {
  return {
    id: row.id,
    bookId: row.book_id,
    name: row.name,
    hidden: !!row.hidden,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Doc requirement: a tag is a single word, letters only, at least 3 characters -- no punctuation/spaces/digits. */
export function isValidTagName(name: string): boolean {
  return /^[A-Za-z]{3,}$/.test(name);
}

export function createTag(db: Database.Database, input: { bookId: string; name: string }): TagRow {
  if (!isValidTagName(input.name)) {
    throw new Error(`Invalid tag name "${input.name}": letters only, at least 3 characters`);
  }
  const id = newId();
  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO tags (id, book_id, name, hidden, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?)`
  ).run(id, input.bookId, input.name, createdAt, createdAt);
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
    throw new Error(`Invalid tag name "${newName}": letters only, at least 3 characters`);
  }
  db.prepare(`UPDATE tags SET name = ?, updated_at = ? WHERE id = ?`).run(newName, nowIso(), id);
  return getTag(db, id)!;
}

/** Doc: delete is a toggle, not a real delete -- consistent with nothing-is-deleted elsewhere in this schema. */
export function setTagHidden(db: Database.Database, id: string, hidden: boolean): void {
  db.prepare(`UPDATE tags SET hidden = ?, updated_at = ? WHERE id = ?`).run(hidden ? 1 : 0, nowIso(), id);
}
