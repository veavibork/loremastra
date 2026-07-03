import type Database from "better-sqlite3";
import { newId } from "../uuid.js";
import { nowIso } from "./time.js";
import { storyDbPath } from "./story-db.js";

export interface StoryRow {
  id: string;
  ownerUserId: string;
  name: string;
  filePath: string;
  parentStoryId: string | null;
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
}

interface RawStoryRow {
  id: string;
  owner_user_id: string;
  name: string;
  file_path: string;
  parent_story_id: string | null;
  hidden: number;
  created_at: string;
  updated_at: string;
}

function mapStoryRow(row: RawStoryRow): StoryRow {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    filePath: row.file_path,
    parentStoryId: row.parent_story_id,
    hidden: !!row.hidden,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createStory(
  db: Database.Database,
  input: { ownerUserId: string; name: string; parentStoryId?: string | null }
): StoryRow {
  const id = newId();
  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO stories (id, owner_user_id, name, file_path, parent_story_id, hidden, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(id, input.ownerUserId, input.name, storyDbPath(id), input.parentStoryId ?? null, createdAt, createdAt);
  return getStory(db, id)!;
}

export function getStory(db: Database.Database, id: string): StoryRow | null {
  const row = db.prepare(`SELECT * FROM stories WHERE id = ?`).get(id) as RawStoryRow | undefined;
  return row ? mapStoryRow(row) : null;
}

export function listStories(db: Database.Database, ownerUserId: string): StoryRow[] {
  const rows = db
    .prepare(`SELECT * FROM stories WHERE owner_user_id = ? AND hidden = 0 ORDER BY updated_at DESC`)
    .all(ownerUserId) as RawStoryRow[];
  return rows.map(mapStoryRow);
}

/** Unscoped by owner — for operator/global contexts only (startup tracking, dev tooling), never a per-request path. */
export function listAllStories(db: Database.Database): StoryRow[] {
  const rows = db.prepare(`SELECT * FROM stories WHERE hidden = 0 ORDER BY updated_at DESC`).all() as RawStoryRow[];
  return rows.map(mapStoryRow);
}

export function renameStory(db: Database.Database, id: string, name: string): StoryRow {
  db.prepare(`UPDATE stories SET name = ?, updated_at = ? WHERE id = ?`).run(name, nowIso(), id);
  return getStory(db, id)!;
}

export function setStoryHidden(db: Database.Database, id: string, hidden: boolean): void {
  db.prepare(`UPDATE stories SET hidden = ?, updated_at = ? WHERE id = ?`).run(hidden ? 1 : 0, nowIso(), id);
}

export function deleteStory(db: Database.Database, id: string): void {
  db.prepare(`DELETE FROM stories WHERE id = ?`).run(id);
}
