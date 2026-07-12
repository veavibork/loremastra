import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createStoryDb } from './helpers.js'
import { createBook } from '../../src/db/book-store.js'
import { createPageWithText, createRetryText } from '../../src/db/content-store.js'
import { getPage } from '../../src/db/page-store.js'
import { getText } from '../../src/db/text-store.js'

let db: Database.Database
let bookId: string

beforeEach(() => {
  db = createStoryDb()
  bookId = createBook(db, { bookType: 'logbook' }).id
})

describe('createPageWithText', () => {
  it('creates a page and its first text in a transaction', () => {
    const { page, text } = createPageWithText(db, { bookId, role: 'user' })
    expect(page.id).toBeTruthy()
    expect(text.id).toBeTruthy()
    expect(text.pageId).toBe(page.id)
    expect(text.role).toBe('user')
    // page's selected_text_id should point to the text
    const refreshed = getPage(db, page.id)!
    expect(refreshed.selectedTextId).toBe(text.id)
  })
})

describe('createRetryText', () => {
  it('creates a new text version under an existing page', () => {
    const { page, text: first } = createPageWithText(db, { bookId, role: 'user' })
    const retry = createRetryText(db, { pageId: page.id, priorTextId: first.id, role: 'user' })
    expect(retry.pageId).toBe(page.id)
    expect(retry.priorTextId).toBe(first.id)
    // page should now select the retry text
    expect(getPage(db, page.id)!.selectedTextId).toBe(retry.id)
  })
})
