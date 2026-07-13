import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createStoryDb } from '../db/helpers.js'
import { createBook } from '../../src/db/book-store.js'
import { createPageWithText } from '../../src/db/content-store.js'
import {
  createStoryToDateSegment,
  fillStoryToDateSegment,
} from '../../src/db/story-to-date-store.js'
import {
  buildMemorySummary,
  buildMemoryManifest,
  backfillContentStamps,
} from '../../src/services/context-manifest.js'

let db: Database.Database
let logbookId: string

beforeEach(() => {
  db = createStoryDb()
  logbookId = createBook(db, { bookType: 'logbook' }).id
})

describe('backfillContentStamps', () => {
  it('stamps pages in a chain', () => {
    const p1 = createPageWithText(db, {
      bookId: logbookId,
      role: 'agent',
      genPackage: '{"role":"assistant","content":"post one"}',
    })
    createPageWithText(db, {
      bookId: logbookId,
      role: 'user',
      genPackage: '{"role":"user","content":"post two"}',
      prevPageId: p1.page.id,
    })

    const result = backfillContentStamps(db)
    expect(result.stamped + result.skipped).toBeGreaterThanOrEqual(2)
  })

  it('returns zero when logbook has no pages', () => {
    const result = backfillContentStamps(db)
    expect(result.stamped).toBe(0)
    expect(result.skipped).toBe(0)
  })
})

describe('buildMemoryManifest', () => {
  it('counts posts and segments from a page chain', () => {
    const p1 = createPageWithText(db, {
      bookId: logbookId,
      role: 'agent',
      genPackage: '{"role":"assistant","content":"post one"}',
    })
    createPageWithText(db, {
      bookId: logbookId,
      role: 'user',
      genPackage: '{"role":"user","content":"post two"}',
      prevPageId: p1.page.id,
    })
    const seg = createStoryToDateSegment(db, { bookId: logbookId, kind: 'begins', seq: 0 })
    fillStoryToDateSegment(db, seg.id, {
      content: 'The story begins.',
      coverageThroughIcPost: 2,
      coveragePageId: 'page-2',
      inputCeilingIcPost: 2,
      inputCeilingPageId: 'page-2',
    })

    const manifest = buildMemoryManifest(db, logbookId)
    expect(manifest.postCount).toBe(2)
    expect(manifest.segments).toHaveLength(1)
    expect(manifest.segments[0].hasContent).toBe(true)
    expect(manifest.segments[0].broken).toBe(false)
  })
})

describe('buildMemorySummary', () => {
  it('returns correct counts for chained posts with filled segment', () => {
    const p1 = createPageWithText(db, {
      bookId: logbookId,
      role: 'agent',
      genPackage: '{"role":"assistant","content":"post one"}',
    })
    createPageWithText(db, {
      bookId: logbookId,
      role: 'user',
      genPackage: '{"role":"user","content":"post two"}',
      prevPageId: p1.page.id,
    })
    const seg = createStoryToDateSegment(db, { bookId: logbookId, kind: 'begins', seq: 0 })
    fillStoryToDateSegment(db, seg.id, {
      content: 'The story begins.',
      coverageThroughIcPost: 1,
      coveragePageId: 'page-1',
      inputCeilingIcPost: 2,
      inputCeilingPageId: 'page-2',
    })

    const summary = buildMemorySummary(db, logbookId)
    expect(summary.postCount).toBe(2)
    expect(summary.storyToDateSegmentCount).toBe(1)
    expect(summary.segmentsMissingContent).toBe(0)
    expect(summary.brokenSegments).toBe(0)
    expect(summary.coverageThroughPost).toBe(1)
  })

  it('counts segments with missing content', () => {
    createPageWithText(db, {
      bookId: logbookId,
      role: 'agent',
      genPackage: '{"role":"assistant","content":"post"}',
    })
    createStoryToDateSegment(db, { bookId: logbookId, kind: 'begins', seq: 0 })

    const summary = buildMemorySummary(db, logbookId)
    expect(summary.segmentsMissingContent).toBe(1)
  })
})
