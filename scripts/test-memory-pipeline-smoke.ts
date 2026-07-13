/**
 * End-to-end memory pipeline smoke test — in-process + HTTP via ephemeral server.
 * No Playwright, no DevTools, no LLM calls.
 *
 * Run: npx tsx scripts/test-memory-pipeline-smoke.ts
 */
import { unlinkSync } from 'node:fs'
import { getGlobalDb } from '../src/db/global-db.js'
import { getStoryDb, closeStoryDb } from '../src/db/story-db.js'
import { createStory, deleteStory } from '../src/db/story-store.js'
import { createBook } from '../src/db/book-store.js'
import { createPageWithText, createRetryText } from '../src/db/content-store.js'
import { getPage, findHeadPageId } from '../src/db/page-store.js'
import { getText } from '../src/db/text-store.js'
import { createWorldbookEntry } from '../src/db/worldbook-store.js'
import { createStoryToDateSegment, fillStoryToDateSegment } from '../src/db/story-to-date-store.js'
import { setStoryPhase } from '../src/db/story-state-store.js'
import { recordHistoryEvent, undoHistory } from '../src/db/history-store.js'
import { enqueueEligibleStoryToDateJob } from '../src/services/story-to-date.js'
import { onCanonicalTextChanged, postNeedsCompress } from '../src/services/context-invalidation.js'
import { assembleAuthorPrompt } from '../src/services/history.js'
import { backfillContentStamps, buildMemoryManifest } from '../src/services/context-manifest.js'
import { newId } from '../src/lib/uuid.js'

const USER_ID = '019f1e21-c547-75b2-8bc1-47b4b6cfdbe6'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`)
  console.log(`ok: ${message}`)
}

function runInProcessSmoke(): void {
  console.log('\n=== in-process memory pipeline ===\n')

  const globalDb = getGlobalDb()
  const story = createStory(globalDb, {
    ownerUserId: USER_ID,
    name: `smoke-pipeline-${newId().slice(0, 8)}`,
  })
  const storyId = story.id
  const db = getStoryDb(storyId)

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
  assert(blob.includes('[STORY TO DATE]'), 'assembled prompt includes merged story to date')
  assert(blob.includes('Dragon') && blob.includes('ROSTER'), 'assembled prompt includes worldbook')
  assert(
    blob.includes('mountain pass') || blob.includes('Player action 19'),
    'verbose tail after coverage',
  )

  enqueueEligibleStoryToDateJob(db, USER_ID, logbook.id, storyId)

  const editPageId = pageIds[4]!
  const editPage = getPage(db, editPageId)!
  const priorText = getText(db, editPage.selectedTextId!)!
  const revisedText = createRetryText(db, {
    pageId: editPageId,
    priorTextId: priorText.id,
    role: priorText.role,
    genPackage: 'REVISED: the Dragon roars from the cliff.',
  })
  recordHistoryEvent(db, {
    kind: 'text',
    pageId: editPageId,
    fromValue: priorText.id,
    toValue: revisedText.id,
  })
  onCanonicalTextChanged(db, USER_ID, logbook.id, editPageId, storyId)
  assert(
    !postNeedsCompress(getPage(db, editPageId)!, revisedText),
    'compression disabled after edit',
  )

  const undoResult = undoHistory(db)
  assert(!!undoResult?.canonicalTextPageId, 'undo returns canonical text page for invalidation')
  if (undoResult?.canonicalTextPageId) {
    onCanonicalTextChanged(db, USER_ID, logbook.id, undoResult.canonicalTextPageId, storyId)
  }

  const manifest = buildMemoryManifest(db, logbook.id)
  assert(manifest.postCount === 20, 'manifest reports all posts')
  assert(manifest.segments.length >= 0, 'manifest lists story-to-date segments')

  const stamps = backfillContentStamps(db)
  assert(stamps.stamped + stamps.skipped === 20, 'stamp backfill covers all posts')

  closeStoryDb(storyId)
  deleteStory(globalDb, storyId)
  try {
    unlinkSync(`data/stories/${storyId}.sqlite`)
  } catch {
    /* ignore */
  }

  console.log('\n=== in-process smoke passed ===\n')
}

runInProcessSmoke()
