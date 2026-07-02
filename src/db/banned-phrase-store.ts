import type Database from "better-sqlite3";
import { newId } from "../uuid.js";
import { nowIso } from "./time.js";

export interface BannedPhraseRow {
  id: string;
  userId: string;
  phrase: string;
  createdAt: string;
}

interface RawBannedPhraseRow {
  id: string;
  user_id: string;
  phrase: string;
  created_at: string;
}

function mapRow(row: RawBannedPhraseRow): BannedPhraseRow {
  return { id: row.id, userId: row.user_id, phrase: row.phrase, createdAt: row.created_at };
}

export function listBannedPhrases(db: Database.Database, userId: string): BannedPhraseRow[] {
  const rows = db
    .prepare(`SELECT * FROM banned_phrases WHERE user_id = ? ORDER BY created_at ASC`)
    .all(userId) as RawBannedPhraseRow[];
  return rows.map(mapRow);
}

export function createBannedPhrase(db: Database.Database, userId: string, phrase: string): BannedPhraseRow {
  const id = newId();
  db.prepare(`INSERT INTO banned_phrases (id, user_id, phrase, created_at) VALUES (?, ?, ?, ?)`).run(
    id,
    userId,
    phrase,
    nowIso()
  );
  return { id, userId, phrase, createdAt: nowIso() };
}

export function deleteBannedPhrase(db: Database.Database, id: string): void {
  db.prepare(`DELETE FROM banned_phrases WHERE id = ?`).run(id);
}
