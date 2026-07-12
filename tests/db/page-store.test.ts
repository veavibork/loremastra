import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createStoryDb } from './helpers.js'
import { createPage, getPage, setSelectedText, setPageHidden } from '../../src/db/page-store.js'
import { createBook } from '../../src/db/book-store.js'
import { createText } from '../../src/db/text-store.js'

let db: Database.Database
let bookId: string

beforeEach(() => {
  db = createStoryDb()
  bookId = createBook(db, { bookType: 'logbook' }).id
})

describe('createPage', () => {
  it('creates a page with defaults', () => {
    const page = createPage(db, { bookId })
    expect(page.id).toBeTruthy()
    expect(page.bookId).toBe(bookId)
    expect(page.hidden).toBe(false)
    expect(page.broken).toBe(false)
    expect(page.prevPageId).toBeNull()
    expect(page.selectedForkPageId).toBeNull()
  })

  it('creates a linked page with prevPageId', () => {
    const first = createPage(db, { bookId })
    const second = createPage(db, { bookId, prevPageId: first.id })
    expect(second.prevPageId).toBe(first.id)
    // prev page's selected_fork_page_id should point to this page
    const updatedFirst = getPage(db, first.id)!
    expect(updatedFirst.selectedForkPageId).toBe(second.id)
  })
})

describe('getPage', () => {
  it('returns the created page', () => {
    const created = createPage(db, { bookId })
    const found = getPage(db, created.id)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(created.id)
  })

  it('returns null for unknown id', () => {
    expect(getPage(db, 'nonexistent')).toBeNull()
  })
})

describe('setSelectedText', () => {
  it('sets the selected text for a page', () => {
    const page = createPage(db, { bookId })
    setSelectedText(db, page.id, 'text-1')
    expect(getPage(db, page.id)!.selectedTextId).toBe('text-1')
  })
})

describe('setPageHidden', () => {
  it('hides and unhides a page', () => {
    const page = createPage(db, { bookId })
    setPageHidden(db, page.id, true)
    expect(getPage(db, page.id)!.hidden).toBe(true)
    setPageHidden(db, page.id, false)
    expect(getPage(db, page.id)!.hidden).toBe(false)
  })
})
