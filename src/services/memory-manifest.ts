import type Database from "better-sqlite3";
import { listChronologicalPages, findHeadPageId, type PageRow } from "../db/page-store.js";
import { getText } from "../db/text-store.js";
import { setMemoryContentStamp } from "../db/page-store.js";
import { listArchivesForBook, listMemberTextIds, getOwnerArchiveForText } from "../db/archive-store.js";
import { listTags, getTag } from "../db/tag-store.js";
import { listTagIdsForText } from "../db/tag-index-store.js";
import { getTagScopeBookId } from "../db/book-store.js";
import { getStoryState } from "../db/story-state-store.js";
import { computeTextContentStamp, postNeedsCompress } from "./content-stamp.js";
import { reindexTagAcrossBook, indexTextAgainstAllTags } from "./tag-index.js";
import { activateTagsFromQuery, buildTagQueryText } from "./tag-retrieval.js";
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

/** Re-grep every tag against every post, and every post against every tag. */
export function reindexAllMemoryTags(db: Database.Database, logbookId: string): { tags: number; texts: number } {
  const tagBookId = getTagScopeBookId(db, logbookId);
  const tags = listTags(db, tagBookId);
  for (const tag of tags) reindexTagAcrossBook(db, tag.id);

  let texts = 0;
  for (const page of listChronologicalPages(db, logbookId)) {
    if (page.hidden || !page.selectedTextId) continue;
    indexTextAgainstAllTags(db, tagBookId, page.selectedTextId);
    texts++;
  }
  return { tags: tags.length, texts };
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

export interface TagActivationPreview {
  fromPageId: string;
  queryTextLength: number;
  queryTextPreview: string;
  activeTags: Array<{ id: string; name: string }>;
}

/** Which tags KAI-style query activation would fire at the given (or current) position. */
export function previewTagActivation(
  db: Database.Database,
  logbookId: string,
  fromPageId?: string | null
): TagActivationPreview {
  const pages = listChronologicalPages(db, logbookId).filter((p) => !p.hidden);
  const resolvedPageId =
    fromPageId ?? getStoryState(db).currentPageId ?? findHeadPageId(db, logbookId);
  const cutoffIdx = resolvedPageId ? pages.findIndex((p) => p.id === resolvedPageId) : pages.length - 1;
  const historyPages: PageRow[] = cutoffIdx >= 0 ? pages.slice(0, cutoffIdx + 1) : pages;

  const tagBookId = getTagScopeBookId(db, logbookId);
  const queryText = buildTagQueryText(db, historyPages);
  const activeIds = activateTagsFromQuery(db, tagBookId, queryText);
  const activeTags = activeIds
    .map((id) => getTag(db, id))
    .filter((t): t is NonNullable<typeof t> => t !== null)
    .map((t) => ({ id: t.id, name: t.name }));

  return {
    fromPageId: resolvedPageId ?? pages[pages.length - 1]?.id ?? "",
    queryTextLength: queryText.length,
    queryTextPreview: queryText.length > 600 ? `${queryText.slice(0, 600)}…` : queryText,
    activeTags,
  };
}

export interface MemoryBackfillResult {
  stamps: { stamped: number; skipped: number };
  tags: { tags: number; texts: number } | null;
  enqueuedJobs: boolean;
  pendingMemoryJobs: number;
  summary: MemorySummary;
}

/** Shared by MCP backfill_memory and POST /memory/backfill. */
export function runMemoryBackfill(
  db: Database.Database,
  userId: string,
  logbookId: string,
  options: { reindexTags?: boolean; enqueueJobs?: boolean } = {}
): MemoryBackfillResult {
  const stamps = backfillContentStamps(db);
  const tags = options.reindexTags !== false ? reindexAllMemoryTags(db, logbookId) : null;
  let pendingMemoryJobs = 0;
  if (options.enqueueJobs !== false) {
    pendingMemoryJobs = enqueueMemoryPipeline(db, userId, logbookId);
  }
  return {
    stamps,
    tags,
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
  tagCount: number;
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
  tagBookId: string;
  postCount: number;
  needsCompressCount: number;
  archiveCount: number;
  posts: MemoryManifestPost[];
  archives: MemoryManifestArchive[];
}

/** Diagnostic snapshot of compress stamps, tag matches, and archive coverage. */
export function buildMemoryManifest(db: Database.Database, logbookId: string): MemoryManifest {
  const tagBookId = getTagScopeBookId(db, logbookId);
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
      tagCount: page.selectedTextId ? listTagIdsForText(db, page.selectedTextId).length : 0,
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
    tagBookId,
    postCount: posts.length,
    needsCompressCount,
    archiveCount: archives.length,
    posts,
    archives,
  };
}
