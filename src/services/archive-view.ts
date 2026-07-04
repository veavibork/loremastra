import type Database from "better-sqlite3";
import { listChronologicalPages } from "../db/page-store.js";
import { getText } from "../db/text-store.js";
import { listArchivesForBook, listMemberTextIds } from "../db/archive-store.js";
import { hasActiveJobForArchive } from "../db/job-store.js";
import { ARCHIVE_BLOCK_SIZE } from "./archive.js";

export type ArchiveViewStatus = "ready" | "pending" | "broken" | "missing";

export interface ArchiveViewEntry {
  /** Null when no archive row exists yet for this decad slot. */
  id: string | null;
  createdAt: string | null;
  summary: string | null;
  name: string | null;
  hidden: boolean;
  broken: boolean;
  memberCount: number;
  /** 0-based index in chronological log (in-character pages only unless includeHidden). */
  startIndex: number;
  endIndex: number;
  startPageId: string;
  endPageId: string;
  status: ArchiveViewStatus;
  /** All posts in the window have prose — manual Queue can create/run the archive job. */
  queueEligible: boolean;
  archiveJobActive: boolean;
  nameJobActive: boolean;
}

export interface ArchiveViewPage {
  archives: ArchiveViewEntry[];
  total: number;
  withSummary: number;
  pending: number;
  broken: number;
  missingRows: number;
}

/** Archive blocks for the Archives tab — includes missing decad slots; most recent first. */
export function buildArchiveView(
  db: Database.Database,
  logbookId: string,
  options: { includeHidden?: boolean } = {}
): ArchiveViewPage {
  const includeHidden = options.includeHidden ?? false;
  const pages = listChronologicalPages(db, logbookId).filter((p) => includeHidden || !p.hidden);
  const indexOf = new Map(pages.map((p, i) => [p.id, i]));

  const archivesByStartPage = new Map(
    listArchivesForBook(db, logbookId).map((a) => [a.startPageId, a] as const)
  );

  const entries: ArchiveViewEntry[] = [];

  for (let start = 0; start + ARCHIVE_BLOCK_SIZE <= pages.length; start += ARCHIVE_BLOCK_SIZE) {
    const windowPages = pages.slice(start, start + ARCHIVE_BLOCK_SIZE);
    const startPage = windowPages[0]!;
    const endPage = windowPages[windowPages.length - 1]!;
    const queueEligible = windowPages.every((p) => {
      if (!p.selectedTextId) return false;
      const text = getText(db, p.selectedTextId);
      return !!text?.genPackage?.trim();
    });

    const archive = archivesByStartPage.get(startPage.id);

    if (!archive) {
      entries.push({
        id: null,
        createdAt: null,
        summary: null,
        name: null,
        hidden: false,
        broken: false,
        memberCount: 0,
        startIndex: start,
        endIndex: start + ARCHIVE_BLOCK_SIZE - 1,
        startPageId: startPage.id,
        endPageId: endPage.id,
        status: "missing",
        queueEligible,
        archiveJobActive: false,
        nameJobActive: false,
      });
      continue;
    }

    const startIndex = indexOf.get(archive.startPageId);
    const endIndex = indexOf.get(archive.endPageId);
    if (startIndex == null || endIndex == null) continue;

    let status: ArchiveViewStatus = "pending";
    if (archive.broken) status = "broken";
    else if (archive.summary?.trim()) status = "ready";

    entries.push({
      id: archive.id,
      createdAt: archive.createdAt,
      summary: archive.summary,
      name: archive.name,
      hidden: archive.hidden,
      broken: archive.broken,
      memberCount: listMemberTextIds(db, archive.id).length,
      startIndex,
      endIndex,
      startPageId: archive.startPageId,
      endPageId: archive.endPageId,
      status,
      queueEligible,
      archiveJobActive: hasActiveJobForArchive(db, archive.id, "archive"),
      nameJobActive: hasActiveJobForArchive(db, archive.id, "archive-name"),
    });
  }

  entries.sort((a, b) => b.startIndex - a.startIndex);

  return {
    archives: entries,
    total: entries.length,
    withSummary: entries.filter((a) => a.status === "ready").length,
    pending: entries.filter((a) => a.status === "pending" || a.status === "missing").length,
    broken: entries.filter((a) => a.status === "broken").length,
    missingRows: entries.filter((a) => a.status === "missing").length,
  };
}
