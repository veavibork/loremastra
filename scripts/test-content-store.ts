import { getStoryDb } from '../src/db/story-db.js'
import { createBook } from '../src/db/book-store.js'
import { getPage, setPageHidden } from '../src/db/page-store.js'
import { fillTextGeneration, getText, setTextHidden } from '../src/db/text-store.js'
import { createPageWithText, createRetryText } from '../src/db/content-store.js'
import { newId } from '../src/uuid.js'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`)
  console.log(`ok: ${message}`)
}

const db = getStoryDb(`smoke-${newId()}`)

const logbook = createBook(db, { bookType: 'logbook' })
assert(logbook.bookType === 'logbook', 'book created with correct type')

// A user posts something.
const { page, text: firstText } = createPageWithText(db, {
  bookId: logbook.id,
  role: 'user',
  genPackage: 'The player opens the door.',
})
assert(getPage(db, page.id)!.selectedTextId === firstText.id, 'new page selects its first text')

// The user edits that post — a new text version, same page, becomes canonical.
const editedText = createRetryText(db, {
  pageId: page.id,
  priorTextId: firstText.id,
  role: 'user',
  genPackage: 'The player kicks open the door.',
})
assert(editedText.priorTextId === firstText.id, 'edited text records lineage to the original')
assert(getPage(db, page.id)!.selectedTextId === editedText.id, 'page selection moves to the edit')
assert(getText(db, firstText.id) !== null, 'original text row still exists, not deleted')

// An author reply, generated after the fact.
const { page: replyPage, text: replyText } = createPageWithText(db, {
  bookId: logbook.id,
  prevPageId: page.id,
  role: 'agent',
  genRequest: null,
  genPackage: null,
})
const filled = fillTextGeneration(db, replyText.id, {
  genPackage: 'The door creaks open into darkness.',
})
assert(filled, 'first fill of gen_package succeeds')
const filledAgain = fillTextGeneration(db, replyText.id, { genPackage: 'overwrite attempt' })
assert(!filledAgain, 'second fill of gen_package is a no-op (write-once)')
assert(
  getText(db, replyText.id)!.genPackage === 'The door creaks open into darkness.',
  'original generation preserved',
)

// Hide/broken toggles don't delete anything.
setTextHidden(db, firstText.id, true)
assert(getText(db, firstText.id)!.hidden === true, 'text can be hidden')
setPageHidden(db, replyPage.id, true)
assert(getPage(db, replyPage.id)!.hidden === true, 'page can be hidden')

console.log('\nAll content-store checks passed.')
