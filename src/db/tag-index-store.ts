import type Database from "better-sqlite3";
import { nowIso } from "./time.js";

export function addTagMatch(db: Database.Database, tagId: string, textId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO tag_index (tag_id, text_id, matched_at) VALUES (?, ?, ?)`
  ).run(tagId, textId, nowIso());
}

export function removeTagMatch(db: Database.Database, tagId: string, textId: string): void {
  db.prepare(`DELETE FROM tag_index WHERE tag_id = ? AND text_id = ?`).run(tagId, textId);
}

export function clearMatchesForTag(db: Database.Database, tagId: string): void {
  db.prepare(`DELETE FROM tag_index WHERE tag_id = ?`).run(tagId);
}

export function listTextIdsForTag(db: Database.Database, tagId: string): string[] {
  const rows = db.prepare(`SELECT text_id FROM tag_index WHERE tag_id = ?`).all(tagId) as Array<{
    text_id: string;
  }>;
  return rows.map((row) => row.text_id);
}

export function listTagIdsForText(db: Database.Database, textId: string): string[] {
  const rows = db.prepare(`SELECT tag_id FROM tag_index WHERE text_id = ?`).all(textId) as Array<{
    tag_id: string;
  }>;
  return rows.map((row) => row.tag_id);
}
