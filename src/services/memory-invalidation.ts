import type Database from 'better-sqlite3'
import { getBookByType } from '../db/book-store.js'
import { cancelPendingJobsForStoryToDate } from '../db/job-store.js'
import { deleteStoryToDateSegment, listStoryToDateSegments } from '../db/story-to-date-store.js'
import { getPage, listChronologicalPages, setMemoryContentStamp } from '../db/page-store.js'
import { getText, setTextBroken } from '../db/text-store.js'
import { computeTextContentStamp } from './content-stamp.js'
import { enqueueEligibleStoryToDateJob, enqueuePendingStoryToDateJobs } from './story-to-date.js'
import { resolveChainPostNumber } from './post-index.js'
import { invalidateStoryReadCache } from './story-read-cache.js'

export { computeTextContentStamp, postNeedsCompress } from './content-stamp.js'

/** Called when a compress job finishes successfully for this page/text pair. */
export function markCompressValid(db: Database.Database, pageId: string, textId: string): void {
  const text = getText(db, textId)
  const stamp = computeTextContentStamp(text)
  if (!stamp) return
  setMemoryContentStamp(db, pageId, stamp)
  setTextBroken(db, textId, false)
}

function invalidateStoryToDateForPage(
  db: Database.Database,
  userId: string,
  logbookId: string,
  storyId: string,
  pageId: string,
): void {
  const pages = listChronologicalPages(db, logbookId).filter((p) => !p.hidden)
  const activeIds = new Set(pages.map((p) => p.id))
  const editedPost = resolveChainPostNumber(db, logbookId, pageId)

  for (const segment of listStoryToDateSegments(db, logbookId, {
    includeHidden: true,
    includeBroken: true,
  })) {
    if (segment.coveragePageId && !activeIds.has(segment.coveragePageId)) {
      cancelPendingJobsForStoryToDate(db, segment.id)
      deleteStoryToDateSegment(db, segment.id)
      continue
    }

    if (!segment.content?.trim()) {
      cancelPendingJobsForStoryToDate(db, segment.id)
      deleteStoryToDateSegment(db, segment.id)
      continue
    }

    const coverageIc = segment.coverageThroughIcPost
    if (editedPost != null && coverageIc != null && editedPost <= coverageIc) {
      cancelPendingJobsForStoryToDate(db, segment.id)
      deleteStoryToDateSegment(db, segment.id)
      continue
    }

    // Fallback when IC numbering unavailable (pre-kickoff edit): compare page order on visible chain.
    if (editedPost == null && coverageIc == null && segment.coveragePageId) {
      const pageIndex = pages.findIndex((p) => p.id === pageId)
      const covIdx = pages.findIndex((p) => p.id === segment.coveragePageId)
      if (pageIndex >= 0 && covIdx >= 0 && pageIndex <= covIdx) {
        cancelPendingJobsForStoryToDate(db, segment.id)
        deleteStoryToDateSegment(db, segment.id)
      }
    }
  }

  enqueueEligibleStoryToDateJob(db, userId, logbookId, storyId)
  enqueuePendingStoryToDateJobs(db, userId, logbookId)
}

export function onCanonicalTextChanged(
  db: Database.Database,
  userId: string,
  logbookId: string,
  pageId: string,
  storyId: string,
): void {
  const page = getPage(db, pageId)
  if (!page) return
  const text = page.selectedTextId ? getText(db, page.selectedTextId) : null
  if (!text?.genPackage?.trim()) return

  invalidateStoryToDateForPage(db, userId, logbookId, storyId, pageId)

  const stamp = computeTextContentStamp(text)
  if (stamp) {
    setMemoryContentStamp(db, pageId, stamp)
    setTextBroken(db, text.id, false)
  }
}

export function pruneStoryToDateOffActiveChain(
  db: Database.Database,
  userId: string,
  logbookId: string,
  storyId: string,
): void {
  const pages = listChronologicalPages(db, logbookId).filter((p) => !p.hidden)
  const activeIds = new Set(pages.map((p) => p.id))

  for (const segment of listStoryToDateSegments(db, logbookId, {
    includeHidden: true,
    includeBroken: true,
  })) {
    if (segment.coveragePageId && !activeIds.has(segment.coveragePageId)) {
      cancelPendingJobsForStoryToDate(db, segment.id)
      deleteStoryToDateSegment(db, segment.id)
    }
  }

  enqueueEligibleStoryToDateJob(db, userId, logbookId, storyId)
}

export function onCanonicalTextChangedForStory(
  db: Database.Database,
  userId: string,
  storyId: string,
  pageId: string,
): void {
  invalidateStoryReadCache(storyId)
  const logbook = getBookByType(db, 'logbook')
  if (!logbook) return
  onCanonicalTextChanged(db, userId, logbook.id, pageId, storyId)
}
