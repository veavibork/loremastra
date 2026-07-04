import type Database from "better-sqlite3";
import { newId } from "../uuid.js";
import { nowIso } from "./time.js";
import type { StoryBlockKind } from "../services/story-to-date-corpus.js";

export interface StoryToDateSegmentRow {
  id: string;
  createdAt: string;
  bookId: string;
  kind: StoryBlockKind;
  content: string | null;
  coverageThroughIcPost: number | null;
  coveragePageId: string | null;
  inputCeilingIcPost: number | null;
  inputCeilingPageId: string | null;
  seq: number;
  name: string | null;
  hidden: boolean;
  broken: boolean;
}

interface RawSegmentRow {
  id: string;
  created_at: string;
  book_id: string;
  kind: StoryBlockKind;
  content: string | null;
  coverage_through_ic_post: number | null;
  coverage_page_id: string | null;
  input_ceiling_ic_post: number | null;
  input_ceiling_page_id: string | null;
  seq: number;
  name: string | null;
  hidden: number;
  broken: number;
}

function mapRow(row: RawSegmentRow): StoryToDateSegmentRow {
  return {
    id: row.id,
    createdAt: row.created_at,
    bookId: row.book_id,
    kind: row.kind,
    content: row.content,
    coverageThroughIcPost: row.coverage_through_ic_post,
    coveragePageId: row.coverage_page_id,
    inputCeilingIcPost: row.input_ceiling_ic_post,
    inputCeilingPageId: row.input_ceiling_page_id,
    seq: row.seq,
    name: row.name ?? null,
    hidden: !!row.hidden,
    broken: !!row.broken,
  };
}

export function listStoryToDateSegments(
  db: Database.Database,
  bookId: string,
  opts: { includeHidden?: boolean; includeBroken?: boolean } = {}
): StoryToDateSegmentRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM story_to_date_segment
       WHERE book_id = ?
       ${opts.includeHidden ? "" : "AND hidden = 0"}
       ${opts.includeBroken ? "" : "AND broken = 0"}
       ORDER BY seq ASC`
    )
    .all(bookId) as RawSegmentRow[];
  return rows.map(mapRow);
}

export function getStoryToDateSegment(db: Database.Database, id: string): StoryToDateSegmentRow | null {
  const row = db.prepare(`SELECT * FROM story_to_date_segment WHERE id = ?`).get(id) as RawSegmentRow | undefined;
  return row ? mapRow(row) : null;
}

export function createStoryToDateSegment(
  db: Database.Database,
  input: { bookId: string; kind: StoryBlockKind; seq: number }
): StoryToDateSegmentRow {
  const id = newId();
  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO story_to_date_segment
     (id, created_at, book_id, kind, content, coverage_through_ic_post, coverage_page_id,
      input_ceiling_ic_post, input_ceiling_page_id, seq, hidden, broken)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, 0, 0)`
  ).run(id, createdAt, input.bookId, input.kind, input.seq);
  return getStoryToDateSegment(db, id)!;
}

export function fillStoryToDateSegment(
  db: Database.Database,
  id: string,
  input: {
    content: string;
    coverageThroughIcPost: number;
    coveragePageId: string;
    inputCeilingIcPost: number;
    inputCeilingPageId: string;
  }
): void {
  db.prepare(
    `UPDATE story_to_date_segment SET
       content = ?,
       coverage_through_ic_post = ?,
       coverage_page_id = ?,
       input_ceiling_ic_post = ?,
       input_ceiling_page_id = ?
     WHERE id = ? AND content IS NULL`
  ).run(
    input.content,
    input.coverageThroughIcPost,
    input.coveragePageId,
    input.inputCeilingIcPost,
    input.inputCeilingPageId,
    id
  );
}

export function fillStoryToDateSegmentName(db: Database.Database, id: string, name: string): boolean {
  const result = db
    .prepare(`UPDATE story_to_date_segment SET name = ? WHERE id = ? AND (name IS NULL OR name = '')`)
    .run(name.trim(), id);
  return result.changes > 0;
}

export function setStoryToDateSegmentName(db: Database.Database, id: string, name: string): void {
  db.prepare(`UPDATE story_to_date_segment SET name = ? WHERE id = ?`).run(name.trim(), id);
}

export function setStoryToDateSegmentContent(db: Database.Database, id: string, content: string): void {
  db.prepare(`UPDATE story_to_date_segment SET content = ? WHERE id = ?`).run(content.trim(), id);
}

export function setStoryToDateSegmentCoverage(
  db: Database.Database,
  id: string,
  input: { coverageThroughIcPost: number; coveragePageId: string }
): void {
  db.prepare(
    `UPDATE story_to_date_segment SET
       coverage_through_ic_post = ?,
       coverage_page_id = ?
     WHERE id = ?`
  ).run(input.coverageThroughIcPost, input.coveragePageId, id);
}

export function markStoryToDateSegmentBroken(db: Database.Database, id: string): void {
  db.prepare(`UPDATE story_to_date_segment SET broken = 1 WHERE id = ?`).run(id);
}

export function deleteStoryToDateSegment(db: Database.Database, id: string): void {
  db.prepare(`DELETE FROM story_to_date_segment WHERE id = ?`).run(id);
}

/** Drop segments at or after seq (for invalidation regen). */
export function deleteStoryToDateSegmentsFromSeq(db: Database.Database, bookId: string, fromSeq: number): void {
  db.prepare(`DELETE FROM story_to_date_segment WHERE book_id = ? AND seq >= ?`).run(bookId, fromSeq);
}

export function hasActiveJobForStoryToDateSegment(
  db: Database.Database,
  segmentId: string,
  jobType = "story-to-date"
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM jobs
       WHERE target_story_to_date_id = ? AND job_type = ? AND status IN ('pending', 'running')
       LIMIT 1`
    )
    .get(segmentId, jobType);
  return !!row;
}

export function cancelPendingJobsForStoryToDateSegment(db: Database.Database, segmentId: string): void {
  db.prepare(
    `UPDATE jobs SET status = 'cancelled', finished_at = ?, error = ?
     WHERE target_story_to_date_id = ? AND status IN ('pending', 'running')`
  ).run(nowIso(), "segment invalidated", segmentId);
}
