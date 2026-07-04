import type Database from "better-sqlite3";
import { newId } from "../uuid.js";
import { nowIso } from "./time.js";

export type BookType = "user" | "game" | "worldbook" | "sourcebook" | "logbook";

export interface BookRow {
  id: string;
  createdAt: string;
  parentBookId: string | null;
  bookType: BookType;
  hidden: boolean;
  broken: boolean;
}

interface RawBookRow {
  id: string;
  created_at: string;
  parent_book_id: string | null;
  book_type: BookType;
  hidden: number;
  broken: number;
}

function mapBookRow(row: RawBookRow): BookRow {
  return {
    id: row.id,
    createdAt: row.created_at,
    parentBookId: row.parent_book_id,
    bookType: row.book_type,
    hidden: !!row.hidden,
    broken: !!row.broken,
  };
}

export function createBook(
  db: Database.Database,
  input: { bookType: BookType; parentBookId?: string | null }
): BookRow {
  const id = newId();
  db.prepare(
    `INSERT INTO book (id, created_at, parent_book_id, book_type, hidden, broken)
     VALUES (?, ?, ?, ?, 0, 0)`
  ).run(id, nowIso(), input.parentBookId ?? null, input.bookType);
  return getBook(db, id)!;
}

export function getBook(db: Database.Database, id: string): BookRow | null {
  const row = db.prepare(`SELECT * FROM book WHERE id = ?`).get(id) as RawBookRow | undefined;
  return row ? mapBookRow(row) : null;
}

export function setBookHidden(db: Database.Database, id: string, hidden: boolean): void {
  db.prepare(`UPDATE book SET hidden = ? WHERE id = ?`).run(hidden ? 1 : 0, id);
}

export function setBookBroken(db: Database.Database, id: string, broken: boolean): void {
  db.prepare(`UPDATE book SET broken = ? WHERE id = ?`).run(broken ? 1 : 0, id);
}

/** Assumes one book per type per story — true until worldbook/sourcebook are introduced alongside logbook. */
export function getBookByType(db: Database.Database, bookType: BookType): BookRow | null {
  const row = db
    .prepare(`SELECT * FROM book WHERE book_type = ? ORDER BY created_at ASC LIMIT 1`)
    .get(bookType) as RawBookRow | undefined;
  return row ? mapBookRow(row) : null;
}
