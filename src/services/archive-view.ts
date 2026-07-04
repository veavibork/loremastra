import type Database from "better-sqlite3";
import { listChronologicalPages } from "../db/page-store.js";
import { listArchivesForBook, listMemberTextIds } from "../db/archive-store.js";

export interface ArchiveViewEntry {
  id: string;
  createdAt: string;
  summary: string | null;
  hidden: boolean;
  broken: boolean;
  memberCount: number;
  /** 0-based index in chronological log (in-character pages only unless includeHidden). */
  startIndex: number;
  endIndex: number;
  startPageId: string;
  endPageId: string;
}

export interface ArchiveViewPage {
  archives: ArchiveViewEntry[];
  total: number;
  withSummary: number;
  pending: number;
  broken: number;
}

/** Archive blocks for the Archives tab — most recent window first. */
export function buildArchiveView(
  db: Database.Database,
  logbookId: string,
  options: { includeHidden?: boolean } = {}
): ArchiveViewPage {
  const includeHidden = options.includeHidden ?? false;
  const pages = listChronologicalPages(db, logbookId).filter((p) => includeHidden || !p.hidden);
  const indexOf = new Map(pages.map((p, i) => [p.id, i]));

  const archives: ArchiveViewEntry[] = listArchivesForBook(db, logbookId)
    .map((archive) => {
      const startIndex = indexOf.get(archive.startPageId);
      const endIndex = indexOf.get(archive.endPageId);
      if (startIndex == null || endIndex == null) return null;
      return {
        id: archive.id,
        createdAt: archive.createdAt,
        summary: archive.summary,
        hidden: archive.hidden,
        broken: archive.broken,
        memberCount: listMemberTextIds(db, archive.id).length,
        startIndex,
        endIndex,
        startPageId: archive.startPageId,
        endPageId: archive.endPageId,
      };
    })
    .filter((a): a is ArchiveViewEntry => a !== null)
    .sort((a, b) => b.startIndex - a.startIndex);

  return {
    archives,
    total: archives.length,
    withSummary: archives.filter((a) => !!a.summary?.trim()).length,
    pending: archives.filter((a) => !a.summary?.trim()).length,
    broken: archives.filter((a) => a.broken).length,
  };
}
