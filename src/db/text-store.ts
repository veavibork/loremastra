import type Database from "better-sqlite3";
import { newId } from "../uuid.js";
import { nowIso } from "./time.js";

export type TextRole = "user" | "agent" | "system";

export interface TextRow {
  id: string;
  createdAt: string;
  pageId: string;
  priorTextId: string | null;
  role: TextRole;
  sourcePageId: string | null;
  hidden: boolean;
  broken: boolean;
  genRequest: string | null;
  genPackage: string | null;
  genMetrics: string | null;
  genExtract: string | null;
  compressMetrics: string | null;
}

interface RawTextRow {
  id: string;
  created_at: string;
  page_id: string;
  prior_text_id: string | null;
  role: TextRole;
  source_page_id: string | null;
  hidden: number;
  broken: number;
  gen_request: string | null;
  gen_package: string | null;
  gen_metrics: string | null;
  gen_extract: string | null;
  compress_metrics: string | null;
}

function mapTextRow(row: RawTextRow): TextRow {
  return {
    id: row.id,
    createdAt: row.created_at,
    pageId: row.page_id,
    priorTextId: row.prior_text_id,
    role: row.role,
    sourcePageId: row.source_page_id,
    hidden: !!row.hidden,
    broken: !!row.broken,
    genRequest: row.gen_request,
    genPackage: row.gen_package,
    genMetrics: row.gen_metrics,
    genExtract: row.gen_extract,
    compressMetrics: row.compress_metrics,
  };
}

export function createText(
  db: Database.Database,
  input: {
    pageId: string;
    role: TextRole;
    priorTextId?: string | null;
    sourcePageId?: string | null;
    genRequest?: string | null;
    genPackage?: string | null;
  }
): TextRow {
  const id = newId();
  db.prepare(
    `INSERT INTO text (id, created_at, page_id, prior_text_id, role, source_page_id, hidden, broken, gen_request, gen_package, gen_metrics, gen_extract)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, NULL, NULL)`
  ).run(
    id,
    nowIso(),
    input.pageId,
    input.priorTextId ?? null,
    input.role,
    input.sourcePageId ?? null,
    input.genRequest ?? null,
    input.genPackage ?? null
  );
  return getText(db, id)!;
}

export function getText(db: Database.Database, id: string): TextRow | null {
  const row = db.prepare(`SELECT * FROM text WHERE id = ?`).get(id) as RawTextRow | undefined;
  return row ? mapTextRow(row) : null;
}

/** Fills in the generated content once inference completes. No-op if already filled — gen_package is write-once. */
export function fillTextGeneration(
  db: Database.Database,
  id: string,
  input: { genPackage: string; genMetrics?: string | null }
): boolean {
  const result = db
    .prepare(`UPDATE text SET gen_package = ?, gen_metrics = ? WHERE id = ? AND gen_package IS NULL`)
    .run(input.genPackage, input.genMetrics ?? null, id);
  return result.changes > 0;
}

/** Fills in the worker-generated compressed summary. No-op if already filled — gen_extract is write-once. */
export function fillTextExtract(
  db: Database.Database,
  id: string,
  genExtract: string,
  compressMetrics?: string | null
): boolean {
  const result = db
    .prepare(`UPDATE text SET gen_extract = ?, compress_metrics = ? WHERE id = ? AND gen_extract IS NULL`)
    .run(genExtract, compressMetrics ?? null, id);
  return result.changes > 0;
}

export function setTextHidden(db: Database.Database, id: string, hidden: boolean): void {
  db.prepare(`UPDATE text SET hidden = ? WHERE id = ?`).run(hidden ? 1 : 0, id);
}

export function setTextBroken(db: Database.Database, id: string, broken: boolean): void {
  db.prepare(`UPDATE text SET broken = ? WHERE id = ?`).run(broken ? 1 : 0, id);
}

/**
 * The canonical (selected), non-hidden content of every page in a book OR
 * its direct children — what tag indexing and prompt assembly actually
 * operate on. Content lives in child books (logbook, worldbook, ...) while
 * tags are scoped to the shared root, so this has to look one level down.
 */
export function listSelectedTextsForBook(db: Database.Database, bookId: string): TextRow[] {
  const rows = db
    .prepare(
      `SELECT t.* FROM text t
       JOIN page p ON p.selected_text_id = t.id
       JOIN book b ON b.id = p.book_id
       WHERE (b.id = ? OR b.parent_book_id = ?) AND p.hidden = 0 AND t.hidden = 0`
    )
    .all(bookId, bookId) as RawTextRow[];
  return rows.map(mapTextRow);
}
