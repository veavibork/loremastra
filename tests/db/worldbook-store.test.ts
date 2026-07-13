import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createStoryDb } from './helpers.js'
import { createBook } from '../../src/db/book-store.js'
import {
  createWorldbookEntry,
  getWorldbookEntry,
  listWorldbookEntries,
  listContentEntries,
  updateWorldbookEntry,
  setWorldbookEntryHidden,
  normalizeWorldbookStoredContent,
} from '../../src/db/worldbook-store.js'

let db: Database.Database
let bookId: string

beforeEach(() => {
  db = createStoryDb()
  bookId = createBook(db, { bookType: 'worldbook' }).id
})

describe('normalizeWorldbookStoredContent', () => {
  it('trims surrounding whitespace', () => {
    const result = normalizeWorldbookStoredContent('  hello world  ', 'content')
    expect(result).toBe('hello world')
  })

  it('strips leading Entry type: line', () => {
    const result = normalizeWorldbookStoredContent('Entry type: CONTENT\n\nblue door', 'content')
    expect(result).toBe('blue door')
  })

  it('strips trailing close tag', () => {
    const result = normalizeWorldbookStoredContent('blue door[/CONTENT]', 'content')
    expect(result).toBe('blue door')
  })

  it('strips leading bracket tag', () => {
    const result = normalizeWorldbookStoredContent('[MEMORY]\nblue door', 'memory')
    expect(result).toBe('blue door')
  })

  it('handles empty content', () => {
    const result = normalizeWorldbookStoredContent('', 'memory')
    expect(result).toBe('')
  })
})

describe('createWorldbookEntry', () => {
  it('creates a content entry with correct defaults', () => {
    const entry = createWorldbookEntry(db, {
      bookId,
      entryType: 'content',
      content: 'Blue door leads to the crypt.',
    })
    expect(entry.pageId).toBeTruthy()
    expect(entry.bookId).toBe(bookId)
    expect(entry.entryType).toBe('content')
    expect(entry.hidden).toBe(false)
    expect(entry.broken).toBe(false)
    expect(entry.content).toBe('Blue door leads to the crypt.')
    expect(entry.currentTextId).toBeTruthy()
  })

  it('creates a roster entry', () => {
    const entry = createWorldbookEntry(db, { bookId, entryType: 'roster', content: 'Sir Galahad' })
    expect(entry.entryType).toBe('roster')
    expect(entry.content).toBe('Sir Galahad')
  })

  it('creates a memory entry', () => {
    const entry = createWorldbookEntry(db, {
      bookId,
      entryType: 'memory',
      content: 'The king is dead',
    })
    expect(entry.entryType).toBe('memory')
    expect(entry.content).toBe('The king is dead')
  })
})

describe('getWorldbookEntry', () => {
  it('returns entry by pageId', () => {
    const created = createWorldbookEntry(db, { bookId, entryType: 'content', content: 'test' })
    const entry = getWorldbookEntry(db, created.pageId)
    expect(entry).toBeDefined()
    expect(entry!.pageId).toBe(created.pageId)
  })

  it('returns null for non-existent pageId', () => {
    const entry = getWorldbookEntry(db, 'nonexistent-id')
    expect(entry).toBeNull()
  })
})

describe('listWorldbookEntries', () => {
  it('lists entries in chronological order', () => {
    const e1 = createWorldbookEntry(db, { bookId, entryType: 'content', content: 'first' })
    const e2 = createWorldbookEntry(db, { bookId, entryType: 'memory', content: 'second' })
    const entries = listWorldbookEntries(db, bookId)
    expect(entries).toHaveLength(2)
    expect(entries[0].pageId).toBe(e1.pageId)
    expect(entries[1].pageId).toBe(e2.pageId)
  })

  it('excludes hidden entries by default', () => {
    const e1 = createWorldbookEntry(db, { bookId, entryType: 'content', content: 'visible' })
    createWorldbookEntry(db, { bookId, entryType: 'content', content: 'hidden' })
    setWorldbookEntryHidden(db, e1.pageId, true)
    const entries = listWorldbookEntries(db, bookId)
    expect(entries).toHaveLength(1)
  })

  it('includes hidden entries when asked', () => {
    const e1 = createWorldbookEntry(db, { bookId, entryType: 'content', content: 'visible' })
    createWorldbookEntry(db, { bookId, entryType: 'memory', content: 'hidden' })
    setWorldbookEntryHidden(db, e1.pageId, true)
    const entries = listWorldbookEntries(db, bookId, { includeHidden: true })
    expect(entries).toHaveLength(2)
  })

  it('returns empty array for empty book', () => {
    const entries = listWorldbookEntries(db, bookId)
    expect(entries).toEqual([])
  })
})

describe('listContentEntries', () => {
  it('filters to content type only', () => {
    createWorldbookEntry(db, { bookId, entryType: 'content', content: 'c1' })
    createWorldbookEntry(db, { bookId, entryType: 'roster', content: 'r1' })
    createWorldbookEntry(db, { bookId, entryType: 'content', content: 'c2' })
    const entries = listContentEntries(db, bookId)
    expect(entries).toHaveLength(2)
    expect(entries.every((e) => e.entryType === 'content')).toBe(true)
  })

  it('returns empty when no content entries exist', () => {
    createWorldbookEntry(db, { bookId, entryType: 'roster', content: 'r1' })
    expect(listContentEntries(db, bookId)).toHaveLength(0)
  })
})

describe('updateWorldbookEntry', () => {
  it('updates content and creates a new text version', () => {
    const entry = createWorldbookEntry(db, { bookId, entryType: 'content', content: 'original' })
    const updated = updateWorldbookEntry(db, entry.pageId, { content: 'revised' })
    expect(updated.content).toBe('revised')
    expect(updated.currentTextId).not.toBe(entry.currentTextId)
  })

  it('throws when entry does not exist', () => {
    expect(() => updateWorldbookEntry(db, 'nonexistent', { content: 'x' })).toThrow('not found')
  })
})

describe('setWorldbookEntryHidden', () => {
  it('hides and restores an entry', () => {
    const entry = createWorldbookEntry(db, { bookId, entryType: 'content', content: 'test' })
    setWorldbookEntryHidden(db, entry.pageId, true)
    const hiddenEntry = getWorldbookEntry(db, entry.pageId)
    expect(hiddenEntry).toBeDefined()
    expect(hiddenEntry!.hidden).toBe(true)

    setWorldbookEntryHidden(db, entry.pageId, false)
    const restored = getWorldbookEntry(db, entry.pageId)
    expect(restored).toBeDefined()
    expect(restored!.hidden).toBe(false)
  })
})
