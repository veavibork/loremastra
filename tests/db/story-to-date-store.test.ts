import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createStoryDb } from './helpers.js'
import { createBook } from '../../src/db/book-store.js'
import {
  createStoryToDateSegment,
  getStoryToDateSegment,
  listStoryToDateSegments,
  fillStoryToDateSegment,
  fillStoryToDateSegmentName,
  setStoryToDateSegmentName,
  setStoryToDateSegmentContent,
  setStoryToDateSegmentCoverage,
  markStoryToDateSegmentBroken,
  deleteStoryToDateSegment,
  deleteStoryToDateSegmentsFromSeq,
  hasActiveJobForStoryToDateSegment,
  cancelPendingJobsForStoryToDateSegment,
  type StoryToDateSegmentRow,
} from '../../src/db/story-to-date-store.js'
import { createJob, claimNextJob, cancelPendingJobsForStoryToDate } from '../../src/db/job-store.js'
import { runningControllers } from '../../src/queue/cancel.js'

let db: Database.Database
let bookId: string

beforeEach(() => {
  db = createStoryDb()
  bookId = createBook(db, { bookType: 'story' }).id
})

function createSegment(kind: StoryToDateSegmentRow['kind'] = 'begins', seq = 0) {
  return createStoryToDateSegment(db, { bookId, kind, seq })
}

describe('createStoryToDateSegment', () => {
  it('creates a segment with zero defaults', () => {
    const seg = createSegment('begins', 0)
    expect(seg.id).toBeTruthy()
    expect(seg.bookId).toBe(bookId)
    expect(seg.kind).toBe('begins')
    expect(seg.seq).toBe(0)
    expect(seg.hidden).toBe(false)
    expect(seg.broken).toBe(false)
    expect(seg.content).toBeNull()
    expect(seg.name).toBeNull()
    expect(seg.coverageThroughIcPost).toBeNull()
  })
})

describe('getStoryToDateSegment', () => {
  it('returns segment by id', () => {
    const seg = createSegment('begins', 0)
    const fetched = getStoryToDateSegment(db, seg.id)
    expect(fetched).toBeDefined()
    expect(fetched!.id).toBe(seg.id)
  })

  it('returns null for non-existent id', () => {
    expect(getStoryToDateSegment(db, 'nonexistent')).toBeNull()
  })
})

describe('listStoryToDateSegments', () => {
  it('lists segments by bookId ordered by seq', () => {
    const s0 = createSegment('begins', 0)
    const s1 = createSegment('continues', 1)
    const segs = listStoryToDateSegments(db, bookId)
    expect(segs).toHaveLength(2)
    expect(segs[0].id).toBe(s0.id)
    expect(segs[1].id).toBe(s1.id)
  })

  it('excludes hidden segments by default', () => {
    createSegment('begins', 0)
    createSegment('continues', 1)
    db.prepare('UPDATE story_to_date_segment SET hidden = 1 WHERE seq = 0').run()
    const segs = listStoryToDateSegments(db, bookId)
    expect(segs).toHaveLength(1)
    expect(segs[0].seq).toBe(1)
  })

  it('includes hidden when includeHidden is true', () => {
    createSegment('begins', 0)
    createSegment('continues', 1)
    db.prepare('UPDATE story_to_date_segment SET hidden = 1 WHERE seq = 0').run()
    const segs = listStoryToDateSegments(db, bookId, { includeHidden: true })
    expect(segs).toHaveLength(2)
  })

  it('excludes broken by default', () => {
    createSegment('begins', 0)
    createSegment('continues', 1)
    db.prepare('UPDATE story_to_date_segment SET broken = 1 WHERE seq = 0').run()
    const segs = listStoryToDateSegments(db, bookId)
    expect(segs).toHaveLength(1)
  })
})

describe('fillStoryToDateSegment', () => {
  it('fills content and coverage when content is null', () => {
    const seg = createSegment('begins', 0)
    fillStoryToDateSegment(db, seg.id, {
      content: 'Spring turned to summer.',
      coverageThroughIcPost: 12,
      coveragePageId: 'page-12',
      inputCeilingIcPost: 20,
      inputCeilingPageId: 'page-20',
    })
    const filled = getStoryToDateSegment(db, seg.id)!
    expect(filled.content).toBe('Spring turned to summer.')
    expect(filled.coverageThroughIcPost).toBe(12)
    expect(filled.coveragePageId).toBe('page-12')
    expect(filled.inputCeilingIcPost).toBe(20)
    expect(filled.inputCeilingPageId).toBe('page-20')
  })

  it('is a no-op when content is already filled', () => {
    const seg = createSegment('begins', 0)
    fillStoryToDateSegment(db, seg.id, {
      content: 'first fill',
      coverageThroughIcPost: 1,
      coveragePageId: 'p1',
      inputCeilingIcPost: 2,
      inputCeilingPageId: 'p2',
    })
    fillStoryToDateSegment(db, seg.id, {
      content: 'second fill',
      coverageThroughIcPost: 99,
      coveragePageId: 'p99',
      inputCeilingIcPost: 100,
      inputCeilingPageId: 'p100',
    })
    const filled = getStoryToDateSegment(db, seg.id)!
    expect(filled.content).toBe('first fill')
    expect(filled.coverageThroughIcPost).toBe(1)
  })
})

describe('fillStoryToDateSegmentName', () => {
  it('sets name when null', () => {
    const seg = createSegment('begins', 0)
    const ok = fillStoryToDateSegmentName(db, seg.id, 'Chapter 1')
    expect(ok).toBe(true)
    expect(getStoryToDateSegment(db, seg.id)!.name).toBe('Chapter 1')
  })

  it('returns false when name is already set', () => {
    const seg = createSegment('begins', 0)
    fillStoryToDateSegmentName(db, seg.id, 'Original')
    const ok = fillStoryToDateSegmentName(db, seg.id, 'Override')
    expect(ok).toBe(false)
    expect(getStoryToDateSegment(db, seg.id)!.name).toBe('Original')
  })
})

describe('setStoryToDateSegmentName', () => {
  it('overwrites name unconditionally', () => {
    const seg = createSegment('begins', 0)
    fillStoryToDateSegmentName(db, seg.id, 'First')
    setStoryToDateSegmentName(db, seg.id, 'Second')
    expect(getStoryToDateSegment(db, seg.id)!.name).toBe('Second')
  })
})

describe('setStoryToDateSegmentContent', () => {
  it('sets content directly', () => {
    const seg = createSegment('begins', 0)
    setStoryToDateSegmentContent(db, seg.id, 'direct content')
    expect(getStoryToDateSegment(db, seg.id)!.content).toBe('direct content')
  })

  it('overwrites existing content', () => {
    const seg = createSegment('begins', 0)
    fillStoryToDateSegment(db, seg.id, {
      content: 'original',
      coverageThroughIcPost: 0,
      coveragePageId: 'x',
      inputCeilingIcPost: 0,
      inputCeilingPageId: 'y',
    })
    setStoryToDateSegmentContent(db, seg.id, 'revised')
    expect(getStoryToDateSegment(db, seg.id)!.content).toBe('revised')
  })
})

describe('setStoryToDateSegmentCoverage', () => {
  it('updates coverage fields', () => {
    const seg = createSegment('begins', 0)
    setStoryToDateSegmentCoverage(db, seg.id, {
      coverageThroughIcPost: 42,
      coveragePageId: 'page-42',
    })
    const fetched = getStoryToDateSegment(db, seg.id)!
    expect(fetched.coverageThroughIcPost).toBe(42)
    expect(fetched.coveragePageId).toBe('page-42')
  })
})

describe('markStoryToDateSegmentBroken', () => {
  it('marks a segment as broken', () => {
    const seg = createSegment('begins', 0)
    markStoryToDateSegmentBroken(db, seg.id)
    expect(getStoryToDateSegment(db, seg.id)!.broken).toBe(true)
  })
})

describe('deleteStoryToDateSegment', () => {
  it('deletes a segment', () => {
    const seg = createSegment('begins', 0)
    deleteStoryToDateSegment(db, seg.id)
    expect(getStoryToDateSegment(db, seg.id)).toBeNull()
  })

  it('cancels pending jobs before deleting', () => {
    const seg = createSegment('begins', 0)
    createJob(db, { jobType: 'story-to-date', targetStoryToDateId: seg.id })
    expect(hasActiveJobForStoryToDateSegment(db, seg.id)).toBe(true)
    deleteStoryToDateSegment(db, seg.id)
    expect(hasActiveJobForStoryToDateSegment(db, seg.id)).toBe(false)
  })
})

describe('deleteStoryToDateSegmentsFromSeq', () => {
  it('deletes segments at and after seq', () => {
    createSegment('begins', 0)
    createSegment('continues', 1)
    createSegment('begins', 2)
    deleteStoryToDateSegmentsFromSeq(db, bookId, 1)
    const remaining = listStoryToDateSegments(db, bookId)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].seq).toBe(0)
  })
})

describe('hasActiveJobForStoryToDateSegment', () => {
  it('returns true when a pending job targets the segment', () => {
    const seg = createSegment('begins', 0)
    createJob(db, { jobType: 'story-to-date', targetStoryToDateId: seg.id })
    expect(hasActiveJobForStoryToDateSegment(db, seg.id)).toBe(true)
  })

  it('returns false when no job targets the segment', () => {
    const seg = createSegment('begins', 0)
    expect(hasActiveJobForStoryToDateSegment(db, seg.id)).toBe(false)
  })
})

describe('cancelPendingJobsForStoryToDateSegment', () => {
  it('cancels pending jobs for a segment', () => {
    const seg = createSegment('begins', 0)
    createJob(db, { jobType: 'story-to-date', targetStoryToDateId: seg.id })
    cancelPendingJobsForStoryToDateSegment(db, seg.id)
    expect(hasActiveJobForStoryToDateSegment(db, seg.id)).toBe(false)
  })

  it('aborts the in-flight controller for a running job instead of just flipping its status', () => {
    const seg = createSegment('begins', 0)
    createJob(db, { jobType: 'story-to-date', targetStoryToDateId: seg.id })
    const job = claimNextJob(db, ['story-to-date'])!
    const controller = new AbortController()
    runningControllers.set(job.id, controller)
    try {
      cancelPendingJobsForStoryToDateSegment(db, seg.id)
      expect(controller.signal.aborted).toBe(true)
      expect(hasActiveJobForStoryToDateSegment(db, seg.id)).toBe(false)
    } finally {
      runningControllers.delete(job.id)
    }
  })
})

describe('cancelPendingJobsForStoryToDate', () => {
  it('aborts the in-flight controller for a running job instead of just flipping its status', () => {
    const seg = createSegment('begins', 0)
    createJob(db, { jobType: 'story-to-date', targetStoryToDateId: seg.id })
    const job = claimNextJob(db, ['story-to-date'])!
    const controller = new AbortController()
    runningControllers.set(job.id, controller)
    try {
      cancelPendingJobsForStoryToDate(db, seg.id)
      expect(controller.signal.aborted).toBe(true)
      expect(hasActiveJobForStoryToDateSegment(db, seg.id)).toBe(false)
    } finally {
      runningControllers.delete(job.id)
    }
  })
})
