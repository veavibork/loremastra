import type Database from 'better-sqlite3'
import { listChronologicalPages, type PageRow } from '../db/page-store.js'
import { gatherArchiveMembers, ARCHIVE_BLOCK_SIZE } from './archive-eligibility.js'
import {
  createArchive,
  addArchiveMember,
  setArchiveMemberOwner,
  listArchivesForBook,
  listMemberTextIds,
  getArchive,
  resetArchiveForRegen,
} from '../db/archive-store.js'
import { createJob, hasActiveJobForArchive } from '../db/job-store.js'
import { nowIso } from '../db/time.js'
import { getAgentProfile } from './agent-config.js'

// Non-overlapping decads: posts 1–10, 11–20, 21–30, … (Proposal A — no tag-promotion overlap needed).
export { ARCHIVE_BLOCK_SIZE } from './archive-eligibility.js'
const ARCHIVE_BLOCK_STEP = ARCHIVE_BLOCK_SIZE

/**
 * State-based, not position-based: a block is created whenever a complete window of
 * posts with prose exists with no block covering that start point yet.
 */
export function enqueueEligibleArchiveBlocks(
  db: Database.Database,
  userId: string,
  logbookId: string,
): void {
  const pages = listChronologicalPages(db, logbookId).filter((p) => !p.hidden)
  const existingStarts = new Set(listArchivesForBook(db, logbookId).map((a) => a.startPageId))

  for (let start = 0; start < pages.length; start += ARCHIVE_BLOCK_STEP) {
    const anchorPage = pages[start]
    if (!anchorPage || existingStarts.has(anchorPage.id)) continue

    const gathered = gatherArchiveMembers(pages, start, db)
    if (!gathered) continue

    const endPage = gathered.pages[gathered.pages.length - 1]!
    const archive = createArchive(db, {
      bookId: logbookId,
      startPageId: anchorPage.id,
      endPageId: endPage.id,
    })
    for (const text of gathered.texts) {
      addArchiveMember(db, archive.id, text.id, false)
    }
    createArchiveJob(db, userId, archive.id)
  }

  recomputeArchiveOwnership(db, logbookId, pages)
  enqueuePendingArchiveJobs(db, userId, logbookId)
  enqueuePendingArchiveNameJobs(db, userId, logbookId)
}

/** Re-queue archive jobs for blocks that exist but never received a summary. */
export function enqueuePendingArchiveJobs(
  db: Database.Database,
  userId: string,
  logbookId: string,
): number {
  let enqueued = 0
  for (const archive of listArchivesForBook(db, logbookId)) {
    if (archive.summary?.trim() || archive.broken) continue
    if (hasActiveJobForArchive(db, archive.id, 'archive')) continue
    createArchiveJob(db, userId, archive.id)
    enqueued++
  }
  return enqueued
}

/** Queue naming jobs for summarized blocks that never received a scene name (e.g. pre-deploy archives). */
export function enqueuePendingArchiveNameJobs(
  db: Database.Database,
  userId: string,
  logbookId: string,
): number {
  let enqueued = 0
  for (const archive of listArchivesForBook(db, logbookId)) {
    if (!archive.summary?.trim() || archive.broken) continue
    if (archive.name?.trim()) continue
    if (hasActiveJobForArchive(db, archive.id, 'archive-name')) continue
    createJob(db, {
      targetArchiveId: archive.id,
      jobType: 'archive-name',
      slotCost: getAgentProfile(userId, 'worker').concurrencyCost,
      priority: -1,
    })
    enqueued++
  }
  return enqueued
}

export interface QueueArchiveDecadResult {
  archiveId: string
  created: boolean
  queued: boolean
}

/** Create an archive row for a decad (if needed) and queue its summary job. */
export function queueArchiveDecad(
  db: Database.Database,
  userId: string,
  logbookId: string,
  startIndex: number,
): QueueArchiveDecadResult {
  const pages = listChronologicalPages(db, logbookId).filter((p) => !p.hidden)
  if (startIndex < 0 || startIndex >= pages.length) {
    throw new Error(`invalid decad start index ${startIndex} for ${pages.length} posts`)
  }

  const anchorPage = pages[startIndex]
  if (!anchorPage) {
    throw new Error(`invalid decad start index ${startIndex} for ${pages.length} posts`)
  }

  const gathered = gatherArchiveMembers(pages, startIndex, db)
  if (!gathered) {
    throw new Error('not enough prose posts in this window yet')
  }

  const endPage = gathered.pages[gathered.pages.length - 1]!
  let archive = listArchivesForBook(db, logbookId).find((a) => a.startPageId === anchorPage.id)
  let created = false

  if (!archive) {
    archive = createArchive(db, {
      bookId: logbookId,
      startPageId: anchorPage.id,
      endPageId: endPage.id,
    })
    for (const text of gathered.texts) {
      addArchiveMember(db, archive.id, text.id, false)
    }
    created = true
  }

  recomputeArchiveOwnership(db, logbookId, pages)

  if (archive.summary?.trim() && !archive.broken) {
    throw new Error('archive block already has a summary')
  }

  let queued = false
  if (!hasActiveJobForArchive(db, archive.id, 'archive')) {
    createArchiveJob(db, userId, archive.id)
    queued = true
  }

  return { archiveId: archive.id, created, queued }
}

/** Clear summary/name and queue a fresh archive job. */
export function requeueArchiveBlock(
  db: Database.Database,
  userId: string,
  archiveId: string,
): void {
  const archive = getArchive(db, archiveId)
  if (!archive) throw new Error('archive not found')

  resetArchiveForRegen(db, archiveId)
  db.prepare(
    `UPDATE jobs SET status = 'cancelled', finished_at = ?, error = ?
     WHERE target_archive_id = ? AND job_type IN ('archive', 'archive-name') AND status IN ('pending', 'running')`,
  ).run(nowIso(), 'superseded by requeue', archiveId)

  if (!hasActiveJobForArchive(db, archiveId, 'archive')) {
    createArchiveJob(db, userId, archiveId)
  }
}

function createArchiveJob(db: Database.Database, userId: string, archiveId: string): void {
  createJob(db, {
    targetArchiveId: archiveId,
    jobType: 'archive',
    slotCost: getAgentProfile(userId, 'editor').concurrencyCost,
    priority: 5,
  })
}

/**
 * With non-overlapping blocks each post belongs to at most one archive — mark all members owner.
 */
function recomputeArchiveOwnership(
  db: Database.Database,
  logbookId: string,
  pages: PageRow[],
): void {
  const positionOf = new Map(pages.map((p, i) => [p.id, i]))

  for (const archive of listArchivesForBook(db, logbookId)) {
    const startIdx = positionOf.get(archive.startPageId)
    const endIdx = positionOf.get(archive.endPageId)
    if (startIdx == null || endIdx == null) continue

    for (const textId of listMemberTextIds(db, archive.id)) {
      setArchiveMemberOwner(db, archive.id, textId, true)
    }
  }
}
