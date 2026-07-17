/**
 * Story-to-date corpus windowing + coverage-sprint gate.
 *
 * Regression context (2026-07-17, save 019f62e5): a continues job was handed a 60-post
 * backlog, summarized only the final scene, and self-reported [COVERAGE] 56 posts past
 * prior coverage — silently dropping the scenes in between from memory. The bounded
 * input window makes that structurally impossible; the tightened sprint cap is the
 * belt-and-braces behind it.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createStoryDb } from '../db/helpers.js'
import { createBook } from '../../src/db/book-store.js'
import { createPageWithText } from '../../src/db/content-store.js'
import {
  buildStoryCorpus,
  looksNextSceneCoverageSprint,
  NEXT_SCENE_INPUT_WINDOW_POSTS,
  NEXT_SCENE_MAX_COVERAGE_DELTA,
} from '../../src/services/story-to-date/engine.js'

let db: Database.Database
let logbookId: string
let pageIds: string[]

const STORY_ID = 'test-story'
const POST_COUNT = 60

/** Wide budget so the token cutoff never binds — these tests isolate the post window. */
const CORPUS_OPTS = { contextLimit: 200_000, responseLimit: 2_000 }

beforeEach(() => {
  db = createStoryDb()
  logbookId = createBook(db, { bookType: 'logbook' }).id
  pageIds = []
  let prevId: string | null = null
  for (let i = 1; i <= POST_COUNT; i++) {
    const { page } = createPageWithText(db, {
      bookId: logbookId,
      prevPageId: prevId,
      role: i % 2 === 1 ? 'user' : 'agent',
      genPackage: `Post ${i} prose content for the scene in progress.`,
    })
    prevId = page.id
    pageIds.push(page.id)
  }
})

describe('buildStoryCorpus maxIncludedPosts', () => {
  it('caps included posts and the input ceiling at the window', () => {
    const corpus = buildStoryCorpus(db, STORY_ID, logbookId, {
      ...CORPUS_OPTS,
      afterPageId: pageIds[9], // prior coverage through post 10
      maxIncludedPosts: NEXT_SCENE_INPUT_WINDOW_POSTS,
    })
    expect(corpus.includedPosts).toHaveLength(NEXT_SCENE_INPUT_WINDOW_POSTS)
    expect(corpus.includedPosts[0]!.icPostNumber).toBe(11)
    expect(corpus.inputCeilingPost).toBe(10 + NEXT_SCENE_INPUT_WINDOW_POSTS)
    // The claimable delta is structurally capped regardless of what the model reports.
    expect(corpus.inputCeilingPost! - 10).toBeLessThanOrEqual(NEXT_SCENE_MAX_COVERAGE_DELTA)
  })

  it('includes the full backlog when no window is set', () => {
    const corpus = buildStoryCorpus(db, STORY_ID, logbookId, {
      ...CORPUS_OPTS,
      afterPageId: pageIds[9],
    })
    expect(corpus.includedPosts).toHaveLength(POST_COUNT - 10)
    expect(corpus.inputCeilingPost).toBe(POST_COUNT)
  })

  it('returns the remaining tail when the backlog is smaller than the window', () => {
    const corpus = buildStoryCorpus(db, STORY_ID, logbookId, {
      ...CORPUS_OPTS,
      afterPageId: pageIds[POST_COUNT - 5], // 4 posts left
      maxIncludedPosts: NEXT_SCENE_INPUT_WINDOW_POSTS,
    })
    expect(corpus.includedPosts).toHaveLength(4)
    expect(corpus.inputCeilingPost).toBe(POST_COUNT)
  })

  it('counts only visible posts toward the window while numbering stays absolute', () => {
    // Hide posts 12 and 13: they occupy chain numbers but are excluded from Editor input.
    db.prepare('UPDATE page SET hidden = 1 WHERE id IN (?, ?)').run(pageIds[11], pageIds[12])
    const corpus = buildStoryCorpus(db, STORY_ID, logbookId, {
      ...CORPUS_OPTS,
      afterPageId: pageIds[9],
      maxIncludedPosts: 5,
    })
    expect(corpus.includedPosts.map((p) => p.icPostNumber)).toEqual([11, 14, 15, 16, 17])
    expect(corpus.inputCeilingPost).toBe(17)
  })

  it('token budget still binds inside the window', () => {
    const corpus = buildStoryCorpus(db, STORY_ID, logbookId, {
      contextLimit: 100, // usable budget 50 tokens ≈ 4 posts of ~12 tokens
      responseLimit: 50,
      inputCutoff: 1,
      afterPageId: pageIds[9],
      maxIncludedPosts: NEXT_SCENE_INPUT_WINDOW_POSTS,
    })
    expect(corpus.includedPosts.length).toBeGreaterThan(0)
    expect(corpus.includedPosts.length).toBeLessThan(NEXT_SCENE_INPUT_WINDOW_POSTS)
  })
})

describe('looksNextSceneCoverageSprint', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ')

  it('rejects any delta over the hard cap regardless of block length', () => {
    expect(looksNextSceneCoverageSprint(words(2000), NEXT_SCENE_MAX_COVERAGE_DELTA + 1)).toBe(true)
  })

  it('rejects the live failure shape: 236 words claiming 56 posts', () => {
    expect(looksNextSceneCoverageSprint(words(236), 56)).toBe(true)
  })

  it('accepts a normal single-scene block', () => {
    expect(looksNextSceneCoverageSprint(words(150), 12)).toBe(false)
  })

  it('accepts a full-window claim with proportionate length', () => {
    expect(looksNextSceneCoverageSprint(words(120), NEXT_SCENE_MAX_COVERAGE_DELTA)).toBe(false)
  })

  it('still catches thin blocks inside the cap', () => {
    expect(looksNextSceneCoverageSprint(words(40), 20)).toBe(true)
  })
})
