/**
 * In-process smoke test for memory invalidation (no HTTP / Featherless).
 * Run: npx tsx scripts/test-memory-invalidation.ts
 */
import { getStoryDb } from '../src/db/story-db.js'
import { createBook } from '../src/db/book-store.js'
import { createPageWithText, createRetryText } from '../src/db/content-store.js'
import { getPage } from '../src/db/page-store.js'
import { getText } from '../src/db/text-store.js'
import {
  createStoryToDateSegment,
  fillStoryToDateSegment,
  listStoryToDateSegments,
} from '../src/db/story-to-date-store.js'
import { listPendingJobs } from '../src/db/job-store.js'
import { enqueueEligibleStoryToDateJob } from '../src/services/story-to-date.js'
import {
  computeTextContentStamp,
  onCanonicalTextChanged,
  postNeedsCompress,
} from '../src/services/memory-invalidation.js'
import { setStoryPhase } from '../src/db/story-state-store.js'
import { newId } from '../src/uuid.js'

const USER_ID = '019f1e21-c547-75b2-8bc1-47b4b6cfdbe6'
const STORY_ID = `smoke-invalidation-${newId()}`

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`)
  console.log(`ok: ${message}`)
}

const db = getStoryDb(STORY_ID)
const logbook = createBook(db, { bookType: 'logbook' })

let prevId: string | null = null
const pageIds: string[] = []
for (let i = 0; i < 10; i++) {
  const { page } = createPageWithText(db, {
    bookId: logbook.id,
    prevPageId: prevId,
    role: i % 2 === 0 ? 'user' : 'agent',
    genPackage: `Post ${i} content with unique token POST${i}.`,
  })
  prevId = page.id
  pageIds.push(page.id)
}

setStoryPhase(db, 'story')

const oldPageId = pageIds[2]!
const oldPage = getPage(db, oldPageId)!
const oldText = getText(db, oldPage.selectedTextId!)!

assert(
  !postNeedsCompress(oldPage, oldText),
  'compression disabled — postNeedsCompress is always false',
)

const edited = createRetryText(db, {
  pageId: oldPageId,
  priorTextId: oldText.id,
  role: oldText.role,
  genPackage: 'Post 2 REVISED content.',
})
onCanonicalTextChanged(db, USER_ID, logbook.id, oldPageId, STORY_ID)

const editedPage = getPage(db, oldPageId)!
const editedText = getText(db, edited.id)!
assert(!postNeedsCompress(editedPage, editedText), 'compression disabled after edit')
assert(
  listPendingJobs(db).every((j) => j.jobType !== 'compress'),
  'no compress jobs queued on edit',
)
assert(editedPage.memoryContentStamp !== null, 'edit updates content stamp')

const seg = createStoryToDateSegment(db, { bookId: logbook.id, kind: 'begins', seq: 0 })
fillStoryToDateSegment(db, seg.id, {
  content: 'Summary of posts 0–9.',
  coverageThroughIcPost: 9,
  coveragePageId: pageIds[9]!,
  inputCeilingIcPost: 9,
  inputCeilingPageId: pageIds[9]!,
})
const segmentsBefore = listStoryToDateSegments(db, logbook.id).length
assert(segmentsBefore >= 1, 'story-to-date segment exists')

createRetryText(db, {
  pageId: pageIds[4]!,
  priorTextId: getPage(db, pageIds[4]!)!.selectedTextId!,
  role: 'agent',
  genPackage: 'Post 4 totally changed.',
})
onCanonicalTextChanged(db, USER_ID, logbook.id, pageIds[4]!, STORY_ID)
const segmentsAfter = listStoryToDateSegments(db, logbook.id)
assert(
  segmentsAfter.length < segmentsBefore || segmentsAfter.every((s) => !s.content?.trim()),
  'edit inside coverage window invalidated story-to-date segments',
)

const stamp1 = computeTextContentStamp(getText(db, edited.id)!)
const stamp2 = computeTextContentStamp(getText(db, edited.id)!)
assert(stamp1 === stamp2 && stamp1 !== null, 'content stamp is deterministic')

// Enqueue helper runs without throw on prose-only log.
const gapDb = getStoryDb(`smoke-story-to-date-gap-${newId()}`)
const gapLog = createBook(gapDb, { bookType: 'logbook' })
let gapPrev: string | null = null
for (let i = 0; i < 12; i++) {
  const { page } = createPageWithText(gapDb, {
    bookId: gapLog.id,
    prevPageId: gapPrev,
    role: i % 2 === 0 ? 'user' : 'agent',
    genPackage: `Gap post ${i}.`,
  })
  gapPrev = page.id
}
enqueueEligibleStoryToDateJob(gapDb, USER_ID, gapLog.id, `gap-${newId()}`)
assert(true, 'enqueueEligibleStoryToDateJob completes on prose-only log')

console.log('\nAll memory-invalidation smoke checks passed.')
