import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createStoryDb } from '../db/helpers.js'
import { createBook } from '../../src/db/book-store.js'
import { createPageWithText, createRetryText } from '../../src/db/content-store.js'
import { getPage } from '../../src/db/page-store.js'
import { getText } from '../../src/db/text-store.js'
import {
  markCompressValid,
  computeTextContentStamp,
} from '../../src/services/context/invalidation.js'

let db: Database.Database

beforeEach(() => {
  db = createStoryDb()
})

describe('computeTextContentStamp', () => {
  it('returns a non-empty string for valid text', () => {
    const stamp = computeTextContentStamp({
      id: 't1',
      createdAt: 'now',
      pageId: 'p1',
      role: 'agent',
      genPackage: '{"role":"assistant","content":"hello world"}',
      genVariant: null,
      selected: true,
      broken: false,
    })
    expect(stamp).toBeTruthy()
    expect(typeof stamp).toBe('string')
  })

  it('returns null for empty genPackage', () => {
    const stamp = computeTextContentStamp({
      id: 't1',
      createdAt: 'now',
      pageId: 'p1',
      role: 'agent',
      genPackage: '',
      genVariant: null,
      selected: true,
      broken: false,
    })
    expect(stamp).toBeNull()
  })
})

describe('markCompressValid', () => {
  it('sets content hash and clears broken on a page/text pair', () => {
    const bookId = createBook(db, { bookType: 'logbook' }).id
    const { page, text } = createPageWithText(db, {
      bookId,
      role: 'agent',
      genPackage: '{"role":"assistant","content":"test content for stamp"}',
    })

    markCompressValid(db, page.id, text.id)

    const updatedPage = getPage(db, page.id)
    const updatedText = getText(db, text.id)
    expect(updatedPage).toBeDefined()
    expect(updatedPage!.contentHash).toBeTruthy()
    expect(updatedText).toBeDefined()
    expect(updatedText!.broken).toBe(false)
  })

  it('does nothing when text has no stampable content', () => {
    const bookId = createBook(db, { bookType: 'logbook' }).id
    const { page, text } = createPageWithText(db, {
      bookId,
      role: 'agent',
      genPackage: '',
    })

    markCompressValid(db, page.id, text.id)

    const updatedPage = getPage(db, page.id)
    // content_hash should remain null since stamp was null
    expect(updatedPage!.contentHash).toBeNull()
  })
})
