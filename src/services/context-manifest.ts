import type Database from 'better-sqlite3'
import { listChronologicalPages } from '../db/page-store.js'
import { getText } from '../db/text-store.js'
import { setContentHash } from '../db/page-store.js'
import { listStoryToDateSegments } from '../db/story-to-date-store.js'
import { hasActiveJobForStoryToDate, listPendingJobs } from '../db/job-store.js'
import { computeTextContentStamp, postNeedsCompress } from './content-fingerprint.js'
import { enqueueEligibleStoryToDateJob, enqueuePendingStoryToDateJobs } from './story-to-date.js'

/** Adopt content stamps for all canonical posts (idempotent). */
export function backfillContentStamps(db: Database.Database): { stamped: number; skipped: number } {
  let stamped = 0
  let skipped = 0
  for (const page of listChronologicalPages(db, getLogbookId(db))) {
    if (page.hidden || !page.selectedTextId) continue
    const text = getText(db, page.selectedTextId)
    const stamp = computeTextContentStamp(text)
    if (!stamp) {
      skipped++
      continue
    }
    if (page.contentHash !== stamp) {
      setContentHash(db, page.id, stamp)
      stamped++
    } else {
      skipped++
    }
  }
  return { stamped, skipped }
}

export function enqueueMemoryPipeline(
  db: Database.Database,
  userId: string,
  logbookId: string,
  storyId: string,
): number {
  enqueueEligibleStoryToDateJob(db, userId, logbookId, storyId)
  enqueuePendingStoryToDateJobs(db, userId, logbookId)
  return listPendingJobs(db).filter((j) => j.jobType === 'story-to-date').length
}

export interface MemorySummary {
  logbookId: string
  postCount: number
  needsCompressCount: number
  storyToDateSegmentCount: number
  segmentsMissingContent: number
  brokenSegments: number
  coverageThroughPost: number | null
}

export function buildMemorySummary(db: Database.Database, logbookId: string): MemorySummary {
  const full = buildMemoryManifest(db, logbookId)
  const ready = full.segments.filter((s) => s.hasContent && !s.broken)
  const last = ready.sort((a, b) => b.seq - a.seq)[0]
  return {
    logbookId: full.logbookId,
    postCount: full.postCount,
    needsCompressCount: full.needsCompressCount,
    storyToDateSegmentCount: full.segments.length,
    segmentsMissingContent: full.segments.filter((s) => !s.hasContent).length,
    brokenSegments: full.segments.filter((s) => s.broken).length,
    coverageThroughPost: last?.coverageThroughIcPost ?? null,
  }
}

export interface MemoryBackfillResult {
  stamps: { stamped: number; skipped: number }
  enqueuedJobs: boolean
  pendingMemoryJobs: number
  summary: MemorySummary
}

export function runMemoryBackfill(
  db: Database.Database,
  userId: string,
  logbookId: string,
  storyId: string,
  options: { enqueueJobs?: boolean } = {},
): MemoryBackfillResult {
  const stamps = backfillContentStamps(db)
  let pendingMemoryJobs = 0
  if (options.enqueueJobs !== false) {
    pendingMemoryJobs = enqueueMemoryPipeline(db, userId, logbookId, storyId)
  }
  return {
    stamps,
    enqueuedJobs: options.enqueueJobs !== false,
    pendingMemoryJobs,
    summary: buildMemorySummary(db, logbookId),
  }
}

function getLogbookId(db: Database.Database): string {
  const row = db.prepare(`SELECT id FROM book WHERE book_type = 'logbook' LIMIT 1`).get() as
    { id: string } | undefined
  if (!row) throw new Error('no logbook')
  return row.id
}

export interface MemoryManifestPost {
  index: number
  pageId: string
  textId: string | null
  role: string | null
  hasExtract: boolean
  stampMatch: boolean
  needsCompress: boolean
}

export interface MemoryManifestSegment {
  id: string
  kind: string
  seq: number
  hasContent: boolean
  broken: boolean
  coverageThroughIcPost: number | null
  coveragePageId: string | null
  jobActive: boolean
}

export interface MemoryManifest {
  logbookId: string
  postCount: number
  needsCompressCount: number
  segments: MemoryManifestSegment[]
}

export function buildMemoryManifest(db: Database.Database, logbookId: string): MemoryManifest {
  const pages = listChronologicalPages(db, logbookId).filter((p) => !p.hidden)
  const posts: MemoryManifestPost[] = []
  let needsCompressCount = 0

  pages.forEach((page, index) => {
    const text = page.selectedTextId ? getText(db, page.selectedTextId) : null
    const needsCompress = postNeedsCompress(page, text)
    if (needsCompress) needsCompressCount++
    const stamp = computeTextContentStamp(text)
    posts.push({
      index,
      pageId: page.id,
      textId: page.selectedTextId,
      role: text?.role ?? null,
      hasExtract: false,
      stampMatch: !!stamp && page.contentHash === stamp,
      needsCompress,
    })
  })

  const segments: MemoryManifestSegment[] = listStoryToDateSegments(db, logbookId, {
    includeHidden: true,
    includeBroken: true,
  }).map((s) => ({
    id: s.id,
    kind: s.kind,
    seq: s.seq,
    hasContent: !!s.content?.trim(),
    broken: s.broken,
    coverageThroughIcPost: s.coverageThroughIcPost,
    coveragePageId: s.coveragePageId,
    jobActive: hasActiveJobForStoryToDate(db, s.id),
  }))

  return {
    logbookId,
    postCount: posts.length,
    needsCompressCount,
    segments,
  }
}
