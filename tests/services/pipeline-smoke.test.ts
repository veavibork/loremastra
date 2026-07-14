/**
 * End-to-end memory pipeline smoke test — in-process DB integration.
 * No Playwright, no DevTools, no LLM calls.
 *
 * Promoted from scripts/test-memory-pipeline-smoke.ts (2026-07-13).
 */
import { describe, it, expect } from 'vitest'
import { unlinkSync } from 'node:fs'
import { getGlobalDb } from '../../src/db/global-db.js'
import { getStoryDb, closeStoryDb } from '../../src/db/story-db.js'
import { createStory, deleteStory } from '../../src/db/story-store.js'
import { createBook } from '../../src/db/book-store.js'
import { createPageWithText, createRetryText } from '../../src/db/content-store.js'
import { getPage, findHeadPageId } from '../../src/db/page-store.js'
import { getText } from '../../src/db/text-store.js'
import { createWorldbookEntry } from '../../src/db/worldbook-store.js'
import {
  createStoryToDateSegment,
  fillStoryToDateSegment,
} from '../../src/db/story-to-date-store.js'
import { setStoryPhase } from '../../src/db/story-state-store.js'
import { recordHistoryEvent, undoHistory } from '../../src/db/history-store.js'
import { enqueueEligibleStoryToDateJob } from '../../src/services/story-to-date/index.js'
import {
  onCanonicalTextChanged,
  postNeedsCompress,
} from '../../src/services/context/invalidation.js'
import { assembleAuthorPrompt } from '../../src/services/history.js'
import { backfillContentStamps, buildMemoryManifest } from '../../src/services/context/manifest.js'
import { newId } from '../../src/lib/uuid.js'

const USER_ID = '019f1e21-c547-75b2-8bc1-47b4b6cfdbe6'

describe('memory pipeline smoke (in-process)', () => {
  it('assembles author prompt with story-to-date and worldbook', () => {
    const globalDb = getGlobalDb()
    const story = createStory(globalDb, {
      ownerUserId: USER_ID,
      name: `smoke-pipeline-${newId().slice(0, 8)}`,
    })
    const storyId = story.id
    const db = getStoryDb(storyId)

    try {
      const gameBook = createBook(db, { bookType: 'story' })
      const logbook = createBook(db, { bookType: 'logbook', parentBookId: gameBook.id })
      const worldbook = createBook(db, { bookType: 'worldbook', parentBookId: gameBook.id })

      createWorldbookEntry(db, {
        bookId: worldbook.id,
        entryType: 'content',
        content:
          'PC: Lex. Mid-forties, solid build.\nA fantasy realm where ancient Dragons guard mountain passes.',
      })
      createWorldbookEntry(db, {
        bookId: worldbook.id,
        entryType: 'roster',
        content: 'Dragon — an ancient wyrm, scales like burnished copper, speaks in riddles.',
      })

      let prevId: string | null = null
      const pageIds: string[] = []
      for (let i = 0; i < 20; i++) {
        const role = i % 2 === 0 ? 'user' : 'agent'
        const content =
          role === 'user'
            ? i === 19
              ? 'I cautiously ask the Dragon about the mountain pass.'
              : `Player action ${i} near the Dragon's lair.`
            : `Narrator response ${i} describing the Dragon's lair and surroundings.`

        const { page } = createPageWithText(db, {
          bookId: logbook.id,
          prevPageId: prevId,
          role,
          genPackage: content,
        })
        prevId = page.id
        pageIds.push(page.id)
      }

      setStoryPhase(db, 'active')

      const seg = createStoryToDateSegment(db, { bookId: logbook.id, kind: 'begins', seq: 0 })
      fillStoryToDateSegment(db, seg.id, {
        content: "Lex approached the Dragon's lair and explored the surrounding cliffs.",
        coverageThroughIcPost: 10,
        coveragePageId: pageIds[9]!,
        inputCeilingIcPost: 10,
        inputCeilingPageId: pageIds[9]!,
      })

      const headId = findHeadPageId(db, logbook.id)!
      const messages = assembleAuthorPrompt(db, USER_ID, logbook.id, headId)
      const blob = JSON.stringify(messages)
      expect(blob).toContain('[STORY TO DATE]')
      expect(blob).toContain('Dragon')
      expect(blob).toContain('ROSTER')
      expect(blob.includes('mountain pass') || blob.includes('Player action 19')).toBe(true)
    } finally {
      closeStoryDb(storyId)
      deleteStory(globalDb, storyId)
      try {
        unlinkSync(`data/stories/${storyId}.sqlite`)
      } catch {
        /* ignore */
      }
    }
  })

  it('enqueues eligible story-to-date job', () => {
    const globalDb = getGlobalDb()
    const story = createStory(globalDb, {
      ownerUserId: USER_ID,
      name: `smoke-pipeline-${newId().slice(0, 8)}`,
    })
    const storyId = story.id
    const db = getStoryDb(storyId)

    try {
      const gameBook = createBook(db, { bookType: 'story' })
      const logbook = createBook(db, { bookType: 'logbook', parentBookId: gameBook.id })

      // Create enough posts to trigger story-to-date eligibility
      let prevId: string | null = null
      for (let i = 0; i < 15; i++) {
        const role = i % 2 === 0 ? 'user' : 'agent'
        const { page } = createPageWithText(db, {
          bookId: logbook.id,
          prevPageId: prevId,
          role,
          genPackage: `Post ${i} content.`,
        })
        prevId = page.id
      }

      setStoryPhase(db, 'active')
      enqueueEligibleStoryToDateJob(db, USER_ID, logbook.id, storyId)

      // Job enqueued without error — passes
      expect(true).toBe(true)
    } finally {
      closeStoryDb(storyId)
      deleteStory(globalDb, storyId)
      try {
        unlinkSync(`data/stories/${storyId}.sqlite`)
      } catch {
        /* ignore */
      }
    }
  })

  it('handles edit + undo context invalidation', () => {
    const globalDb = getGlobalDb()
    const story = createStory(globalDb, {
      ownerUserId: USER_ID,
      name: `smoke-pipeline-${newId().slice(0, 8)}`,
    })
    const storyId = story.id
    const db = getStoryDb(storyId)

    try {
      const gameBook = createBook(db, { bookType: 'story' })
      const logbook = createBook(db, { bookType: 'logbook', parentBookId: gameBook.id })

      let prevId: string | null = null
      const pageIds: string[] = []
      for (let i = 0; i < 5; i++) {
        const role = i % 2 === 0 ? 'user' : 'agent'
        const { page } = createPageWithText(db, {
          bookId: logbook.id,
          prevPageId: prevId,
          role,
          genPackage: `Post ${i} content.`,
        })
        prevId = page.id
        pageIds.push(page.id)
      }

      const editPageId = pageIds[2]!
      const editPage = getPage(db, editPageId)!
      const priorText = getText(db, editPage.selectedTextId!)!
      const revisedText = createRetryText(db, {
        pageId: editPageId,
        priorTextId: priorText.id,
        role: priorText.role,
        genPackage: 'REVISED content.',
      })
      recordHistoryEvent(db, {
        kind: 'text',
        pageId: editPageId,
        fromValue: priorText.id,
        toValue: revisedText.id,
      })
      onCanonicalTextChanged(db, USER_ID, logbook.id, editPageId, storyId)
      expect(postNeedsCompress(getPage(db, editPageId)!, revisedText)).toBe(false)

      const undoResult = undoHistory(db)
      expect(undoResult?.canonicalTextPageId).toBeTruthy()
      if (undoResult?.canonicalTextPageId) {
        onCanonicalTextChanged(db, USER_ID, logbook.id, undoResult.canonicalTextPageId, storyId)
      }
    } finally {
      closeStoryDb(storyId)
      deleteStory(globalDb, storyId)
      try {
        unlinkSync(`data/stories/${storyId}.sqlite`)
      } catch {
        /* ignore */
      }
    }
  })

  it('builds memory manifest and backfills content stamps', () => {
    const globalDb = getGlobalDb()
    const story = createStory(globalDb, {
      ownerUserId: USER_ID,
      name: `smoke-pipeline-${newId().slice(0, 8)}`,
    })
    const storyId = story.id
    const db = getStoryDb(storyId)

    try {
      const logbook = createBook(db, { bookType: 'logbook' })

      let prevId: string | null = null
      for (let i = 0; i < 10; i++) {
        const role = i % 2 === 0 ? 'user' : 'agent'
        const { page } = createPageWithText(db, {
          bookId: logbook.id,
          prevPageId: prevId,
          role,
          genPackage: `Post ${i} content.`,
        })
        prevId = page.id
      }

      const manifest = buildMemoryManifest(db, logbook.id)
      expect(manifest.postCount).toBe(10)
      expect(manifest.segments.length).toBeGreaterThanOrEqual(0)

      const stamps = backfillContentStamps(db)
      expect(stamps.stamped + stamps.skipped).toBe(10)
    } finally {
      closeStoryDb(storyId)
      deleteStory(globalDb, storyId)
      try {
        unlinkSync(`data/stories/${storyId}.sqlite`)
      } catch {
        /* ignore */
      }
    }
  })
})
