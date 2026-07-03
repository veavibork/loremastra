import type Database from "better-sqlite3";
import { getText } from "../db/text-store.js";
import { getArchive, listArchivesForBook, listMemberTextIds, type ArchiveRow } from "../db/archive-store.js";
import { listChronologicalPages } from "../db/page-store.js";

const PRIOR_ARCHIVE_SUMMARIES = 2;

/** Compressed line per member, falling back to truncated prose when compress is missing. */
export function buildArchiveMemberLines(db: Database.Database, memberTextIds: string[]): string[] {
  const lines: string[] = [];
  for (const id of memberTextIds) {
    const text = getText(db, id);
    if (!text?.genPackage) continue;
    if (text.genExtract?.trim()) {
      lines.push(text.genExtract.trim());
      continue;
    }
    const prose = text.genPackage.replace(/\s+/g, " ").trim();
    lines.push(prose.length > 600 ? `${prose.slice(0, 600)}…` : prose);
  }
  return lines;
}

/** Prior completed archive summaries for continuity (redundancy Z). */
export function buildPriorArchiveContext(db: Database.Database, archive: ArchiveRow): string | null {
  const pages = listChronologicalPages(db, archive.bookId).filter((p) => !p.hidden);
  const positionOf = new Map(pages.map((p, i) => [p.id, i]));
  const startIdx = positionOf.get(archive.startPageId);
  if (startIdx == null) return null;

  const prior = listArchivesForBook(db, archive.bookId)
    .filter((a) => {
      if (a.id === archive.id || !a.summary?.trim() || a.broken) return false;
      const endIdx = positionOf.get(a.endPageId);
      return endIdx != null && endIdx < startIdx;
    })
    .slice(-PRIOR_ARCHIVE_SUMMARIES);

  if (!prior.length) return null;
  return prior.map((a) => a.summary!.trim()).join("\n\n");
}

export function buildArchiveUserPrompt(db: Database.Database, targetArchiveId: string): string {
  const archive = getArchive(db, targetArchiveId);
  if (!archive) throw new Error("target archive no longer exists");

  const memberTextIds = listMemberTextIds(db, targetArchiveId);
  const lines = buildArchiveMemberLines(db, memberTextIds);
  if (!lines.length) throw new Error("no member content to summarize");

  const prior = buildPriorArchiveContext(db, archive);
  if (prior) {
    return `Earlier story summary for continuity:\n${prior}\n\nCompressed scene log to synthesize:\n${lines.join("\n")}`;
  }
  return lines.join("\n");
}
