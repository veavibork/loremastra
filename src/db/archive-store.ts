import type Database from "better-sqlite3";
import { newId } from "../uuid.js";
import { nowIso } from "./time.js";

export interface ArchiveRow {
  id: string;
  createdAt: string;
  bookId: string;
  startPageId: string;
  endPageId: string;
  summary: string | null;
  hidden: boolean;
  broken: boolean;
}

interface RawArchiveRow {
  id: string;
  created_at: string;
  book_id: string;
  start_page_id: string;
  end_page_id: string;
  summary: string | null;
  hidden: number;
  broken: number;
}

function mapArchiveRow(row: RawArchiveRow): ArchiveRow {
  return {
    id: row.id,
    createdAt: row.created_at,
    bookId: row.book_id,
    startPageId: row.start_page_id,
    endPageId: row.end_page_id,
    summary: row.summary,
    hidden: !!row.hidden,
    broken: !!row.broken,
  };
}

export function createArchive(
  db: Database.Database,
  input: { bookId: string; startPageId: string; endPageId: string }
): ArchiveRow {
  const id = newId();
  db.prepare(
    `INSERT INTO archive (id, created_at, book_id, start_page_id, end_page_id, summary, hidden, broken)
     VALUES (?, ?, ?, ?, ?, NULL, 0, 0)`
  ).run(id, nowIso(), input.bookId, input.startPageId, input.endPageId);
  return getArchive(db, id)!;
}

export function getArchive(db: Database.Database, id: string): ArchiveRow | null {
  const row = db.prepare(`SELECT * FROM archive WHERE id = ?`).get(id) as RawArchiveRow | undefined;
  return row ? mapArchiveRow(row) : null;
}

export function listArchivesForBook(db: Database.Database, bookId: string): ArchiveRow[] {
  const rows = db
    .prepare(`SELECT * FROM archive WHERE book_id = ? ORDER BY created_at ASC`)
    .all(bookId) as RawArchiveRow[];
  return rows.map(mapArchiveRow);
}

/** Fills in the editor-generated narrative summary. No-op if already filled — write-once, matching text.gen_extract. */
export function fillArchiveSummary(db: Database.Database, id: string, summary: string): boolean {
  const result = db
    .prepare(`UPDATE archive SET summary = ? WHERE id = ? AND summary IS NULL`)
    .run(summary, id);
  return result.changes > 0;
}

export function setArchiveHidden(db: Database.Database, id: string, hidden: boolean): void {
  db.prepare(`UPDATE archive SET hidden = ? WHERE id = ?`).run(hidden ? 1 : 0, id);
}

/** broken = invalidated (a constituent post changed) — needs regeneration. */
export function setArchiveBroken(db: Database.Database, id: string, broken: boolean): void {
  db.prepare(`UPDATE archive SET broken = ? WHERE id = ?`).run(broken ? 1 : 0, id);
}

export function addArchiveMember(db: Database.Database, archiveId: string, textId: string, isOwner: boolean): void {
  db.prepare(
    `INSERT OR IGNORE INTO archive_member (archive_id, text_id, is_owner) VALUES (?, ?, ?)`
  ).run(archiveId, textId, isOwner ? 1 : 0);
}

export function setArchiveMemberOwner(db: Database.Database, archiveId: string, textId: string, isOwner: boolean): void {
  db.prepare(`UPDATE archive_member SET is_owner = ? WHERE archive_id = ? AND text_id = ?`).run(
    isOwner ? 1 : 0,
    archiveId,
    textId
  );
}

export function listMemberTextIds(db: Database.Database, archiveId: string): string[] {
  const rows = db.prepare(`SELECT text_id FROM archive_member WHERE archive_id = ?`).all(archiveId) as Array<{
    text_id: string;
  }>;
  return rows.map((r) => r.text_id);
}

/** The archive block that "owns" a given post — the one it should be represented by when collapsed, per the doc's proximity-to-midpoint rule. */
export function getOwnerArchiveForText(db: Database.Database, textId: string): ArchiveRow | null {
  const row = db
    .prepare(
      `SELECT a.* FROM archive a
       JOIN archive_member m ON m.archive_id = a.id
       WHERE m.text_id = ? AND m.is_owner = 1
       LIMIT 1`
    )
    .get(textId) as RawArchiveRow | undefined;
  return row ? mapArchiveRow(row) : null;
}
