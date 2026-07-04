import type Database from "better-sqlite3";
import { listChronologicalPages } from "../db/page-store.js";
import { getText } from "../db/text-store.js";
import { setMemoryContentStamp } from "../db/page-store.js";
import { listArchivesForBook, listMemberTextIds, getOwnerArchiveForText } from "../db/archive-store.js";
import { computeTextContentStamp, postNeedsCompress } from "./content-stamp.js";
import { enqueueEligibleArchiveBlocks, enqueuePendingArchiveJobs } from "./archive.js";
import { listPendingJobs } from "../db/job-store.js";

/** Adopt content stamps for all canonical posts (idempotent). */
export function backfillContentStamps(db: Database.Database): { stamped: number; skipped: number } {
  let stamped = 0;
  let skipped = 0;
  for (const page of listChronologicalPages(db, getLogbookId(db))) {
    if (page.hidden || !page.selectedTextId) continue;
    const text = getText(db, page.selectedTextId);
    const stamp = computeTextContentStamp(text);
    if (!stamp) {
      skipped++;
      continue;
    }
    if (page.memoryContentStamp !== stamp) {
      setMemoryContentStamp(db, page.id, stamp);
      stamped++;
    } else {
      skipped++;
    }
  }
  return { stamped, skipped };
}

/** Queue compress + archive jobs for anything currently eligible. */
export function enqueueMemoryPipeline(db: Database.Database, userId: string, logbookId: string): number {
  enqueueEligibleArchiveBlocks(db, userId, logbookId);
  enqueuePendingArchiveJobs(db, userId, logbookId);
  return listPendingJobs(db).filter((j) => j.jobType === "archive").length;
}

export interface MemorySummary {
  logbookId: string;
  postCount: number;
  needsCompressCount: number;
  archiveCount: number;
  archivesMissingSummary: number;
  brokenArchives: number;
  stalePostIndices: number[];
}

/** Compact manifest for quick diagnostics (no per-post dump). */
export function buildMemorySummary(db: Database.Database, logbookId: string): MemorySummary {
  const full = buildMemoryManifest(db, logbookId);
  return {
    logbookId: full.logbookId,
    postCount: full.postCount,
    needsCompressCount: full.needsCompressCount,
    archiveCount: full.archiveCount,
    archivesMissingSummary: full.archives.filter((a) => !a.hasSummary).length,
    brokenArchives: full.archives.filter((a) => a.broken).length,
    stalePostIndices: full.posts.filter((p) => p.needsCompress).map((p) => p.index),
  };
}

export interface MemoryBackfillResult {
  stamps: { stamped: number; skipped: number };
  enqueuedJobs: boolean;
  pendingMemoryJobs: number;
  summary: MemorySummary;
}

/** Shared by MCP backfill_memory and POST /memory/backfill. */
export function runMemoryBackfill(
  db: Database.Database,
  userId: string,
  logbookId: string,
  options: { enqueueJobs?: boolean } = {}
): MemoryBackfillResult {
  const stamps = backfillContentStamps(db);
  let pendingMemoryJobs = 0;
  if (options.enqueueJobs !== false) {
    pendingMemoryJobs = enqueueMemoryPipeline(db, userId, logbookId);
  }
  return {
    stamps,
    enqueuedJobs: options.enqueueJobs !== false,
    pendingMemoryJobs,
    summary: buildMemorySummary(db, logbookId),
  };
}

function getLogbookId(db: Database.Database): string {
  const row = db.prepare(`SELECT id FROM book WHERE book_type = 'logbook' LIMIT 1`).get() as { id: string } | undefined;
  if (!row) throw new Error("no logbook");
  return row.id;
}

export interface MemoryManifestPost {
  index: number;
  pageId: string;
  textId: string | null;
  role: string | null;
  hasExtract: boolean;
  stampMatch: boolean;
  needsCompress: boolean;
  ownedArchiveId: string | null;
}

export interface MemoryManifestArchive {
  id: string;
  startPageId: string;
  endPageId: string;
  hasSummary: boolean;
  broken: boolean;
  memberCount: number;
}

export interface MemoryManifest {
  logbookId: string;
  postCount: number;
  needsCompressCount: number;
  archiveCount: number;
  posts: MemoryManifestPost[];
  archives: MemoryManifestArchive[];
}

/** Diagnostic snapshot of compress stamps and archive coverage. */
export function buildMemoryManifest(db: Database.Database, logbookId: string): MemoryManifest {
  const pages = listChronologicalPages(db, logbookId).filter((p) => !p.hidden);
  const posts: MemoryManifestPost[] = [];
  let needsCompressCount = 0;

  pages.forEach((page, index) => {
    const text = page.selectedTextId ? getText(db, page.selectedTextId) : null;
    const needsCompress = postNeedsCompress(page, text);
    if (needsCompress) needsCompressCount++;
    const stamp = computeTextContentStamp(text);
    posts.push({
      index,
      pageId: page.id,
      textId: page.selectedTextId,
      role: text?.role ?? null,
      hasExtract: !!text?.genExtract,
      stampMatch: !!stamp && page.memoryContentStamp === stamp,
      needsCompress,
      ownedArchiveId: page.selectedTextId ? getOwnerArchiveForText(db, page.selectedTextId)?.id ?? null : null,
    });
  });

  const archives: MemoryManifestArchive[] = listArchivesForBook(db, logbookId).map((a) => ({
    id: a.id,
    startPageId: a.startPageId,
    endPageId: a.endPageId,
    hasSummary: !!a.summary?.trim(),
    broken: a.broken,
    memberCount: listMemberTextIds(db, a.id).length,
  }));

  return {
    logbookId,
    postCount: posts.length,
    needsCompressCount,
    archiveCount: archives.length,
    posts,
    archives,
  };
}
