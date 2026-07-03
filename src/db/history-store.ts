import type Database from "better-sqlite3";
import { newId } from "../uuid.js";
import { nowIso } from "./time.js";
import { getBookByType } from "./book-store.js";
import { findHeadPageId } from "./page-store.js";
import { setSelectedText } from "./page-store.js";
import { getStoryState, setCurrentPageId, getHistoryCursorSeq, setHistoryCursorSeq } from "./story-state-store.js";

export type HistoryEventKind = "page" | "text";

interface HistoryEventRow {
  id: string;
  seq: number;
  kind: HistoryEventKind;
  page_id: string;
  from_value: string | null;
  to_value: string;
}

/**
 * Records a step onto the unified Undo/Redo ledger, after the caller has already applied the
 * underlying change (setCurrentPageId / setSelectedText). Discards any events past the current
 * cursor first — the same "orphan, don't destroy" behavior a new page fork or text version
 * already applies to whatever it's superseding — so a fresh action after an Undo correctly
 * replaces the old redo branch instead of leaving a confusing gap in the sequence.
 */
export function recordHistoryEvent(
  db: Database.Database,
  input: { kind: HistoryEventKind; pageId: string; fromValue: string | null; toValue: string }
): void {
  // A 'page' event with no fromValue means this was the very first page in the whole book —
  // there's nothing before it to undo back to (findHeadPageId would just resolve back to this
  // same page, since it's the only one), so skip logging it rather than create a step that
  // can never be meaningfully undone. 'text' events always have a real fromValue (a page can't
  // be retried/edited before it has a first selected text).
  if (input.kind === "page" && input.fromValue === null) return;

  const run = db.transaction(() => {
    const cursor = getHistoryCursorSeq(db);
    db.prepare(`DELETE FROM history_event WHERE seq > ?`).run(cursor);
    const seq = cursor + 1;
    db.prepare(
      `INSERT INTO history_event (id, seq, created_at, kind, page_id, from_value, to_value) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(newId(), seq, nowIso(), input.kind, input.pageId, input.fromValue, input.toValue);
    setHistoryCursorSeq(db, seq);
  });
  run();
}

function applyPageValue(db: Database.Database, value: string): void {
  const logbook = getBookByType(db, "logbook");
  const headPageId = logbook ? findHeadPageId(db, logbook.id) : null;
  setCurrentPageId(db, value === headPageId ? null : value);
}

/** value is from_value on undo, to_value on redo — both guaranteed non-null (see recordHistoryEvent). */
function applyEvent(db: Database.Database, event: HistoryEventRow, value: string | null): void {
  if (!value) return;
  if (event.kind === "page") {
    applyPageValue(db, value);
  } else {
    setSelectedText(db, event.page_id, value);
  }
}

/** The resolved (never-null) current page id, for reporting back to the caller after an undo/redo. */
function resolveCurrentPageId(db: Database.Database): string | null {
  const logbook = getBookByType(db, "logbook");
  if (!logbook) return null;
  return getStoryState(db).currentPageId ?? findHeadPageId(db, logbook.id);
}

/** Reverses the most recent ledger event and moves the cursor back one step. Null if already at the beginning. */
export function undoHistory(
  db: Database.Database
): { currentPageId: string | null; canonicalTextPageId?: string } | null {
  const cursor = getHistoryCursorSeq(db);
  if (cursor === 0) return null;

  const event = db.prepare(`SELECT * FROM history_event WHERE seq = ?`).get(cursor) as HistoryEventRow | undefined;
  if (!event) return null;

  const run = db.transaction(() => {
    applyEvent(db, event, event.from_value);
    const prev = db
      .prepare(`SELECT seq FROM history_event WHERE seq < ? ORDER BY seq DESC LIMIT 1`)
      .get(cursor) as { seq: number } | undefined;
    setHistoryCursorSeq(db, prev?.seq ?? 0);
  });
  run();

  return {
    currentPageId: resolveCurrentPageId(db),
    ...(event.kind === "text" ? { canonicalTextPageId: event.page_id } : {}),
  };
}

/** Re-applies the next ledger event and moves the cursor forward one step. Null if already at the head of the ledger. */
export function redoHistory(
  db: Database.Database
): { currentPageId: string | null; canonicalTextPageId?: string } | null {
  const cursor = getHistoryCursorSeq(db);
  const next = db.prepare(`SELECT * FROM history_event WHERE seq = ?`).get(cursor + 1) as
    | HistoryEventRow
    | undefined;
  if (!next) return null;

  const run = db.transaction(() => {
    applyEvent(db, next, next.to_value);
    setHistoryCursorSeq(db, next.seq);
  });
  run();

  return {
    currentPageId: resolveCurrentPageId(db),
    ...(next.kind === "text" ? { canonicalTextPageId: next.page_id } : {}),
  };
}

export function canUndoHistory(db: Database.Database): boolean {
  return getHistoryCursorSeq(db) > 0;
}

export function canRedoHistory(db: Database.Database): boolean {
  const cursor = getHistoryCursorSeq(db);
  const next = db.prepare(`SELECT 1 FROM history_event WHERE seq = ?`).get(cursor + 1);
  return !!next;
}
