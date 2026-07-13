import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createStoryDb } from './helpers.js'
import {
  createText,
  getText,
  fillTextGeneration,
  setTextHidden,
  listSelectedTextsForBook,
} from '../../src/db/text-store.js'
import { createBook } from '../../src/db/book-store.js'

let db: Database.Database
let bookId: string

beforeEach(() => {
  db = createStoryDb()
  bookId = createBook(db, { bookType: 'logbook' }).id
})

describe('createText', () => {
  it('creates a text row with defaults', () => {
    const text = createText(db, { pageId: 'p1', role: 'user' })
    expect(text.id).toBeTruthy()
    expect(text.role).toBe('user')
    expect(text.hidden).toBe(false)
    expect(text.broken).toBe(false)
    expect(text.priorTextId).toBeNull()
  })

  it('sets priorTextId and genRequest', () => {
    const text = createText(db, {
      pageId: 'p2',
      role: 'agent',
      priorTextId: 't0',
      genRequest: 'request body',
    })
    expect(text.priorTextId).toBe('t0')
    expect(text.genRequest).toBe('request body')
  })
})

describe('getText', () => {
  it('returns the created text', () => {
    const created = createText(db, { pageId: 'p3', role: 'user' })
    const found = getText(db, created.id)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(created.id)
  })

  it('returns null for unknown id', () => {
    expect(getText(db, 'nonexistent')).toBeNull()
  })
})

describe('fillTextGeneration', () => {
  it('fills gen_package and gen_metrics write-once', () => {
    const text = createText(db, { pageId: 'p4', role: 'agent' })
    expect(
      fillTextGeneration(db, text.id, {
        genPackage: 'reply',
        genMetrics: JSON.stringify({ elapsedMs: 100 }),
      }),
    ).toBe(true)
    const updated = getText(db, text.id)!
    expect(updated.genPackage).toBe('reply')
    expect(updated.genMetrics).toBe(JSON.stringify({ elapsedMs: 100 }))
  })

  it('is idempotent — second call returns false', () => {
    const text = createText(db, { pageId: 'p5', role: 'agent' })
    fillTextGeneration(db, text.id, { genPackage: 'first' })
    expect(fillTextGeneration(db, text.id, { genPackage: 'second' })).toBe(false)
    expect(getText(db, text.id)!.genPackage).toBe('first')
  })
})

describe('setTextHidden', () => {
  it('hides and unhides a text', () => {
    const text = createText(db, { pageId: 'p6', role: 'agent' })
    setTextHidden(db, text.id, true)
    expect(getText(db, text.id)!.hidden).toBe(true)
    setTextHidden(db, text.id, false)
    expect(getText(db, text.id)!.hidden).toBe(false)
  })
})

describe('listSelectedTextsForBook', () => {
  it('returns texts for selected pages in a book', () => {
    // Create page + text + selection via raw SQL since content-store creates all three
    db.prepare(
      "INSERT INTO page (id, created_at, book_id, prev_page_id, selected_fork_page_id, selected_text_id, select_time, hidden, broken) VALUES ('pg1', datetime('now'), ?, NULL, NULL, NULL, NULL, 0, 0)",
    ).run(bookId)
    const text = createText(db, { pageId: 'pg1', role: 'user' })
    db.prepare('UPDATE page SET selected_text_id = ? WHERE id = ?').run(text.id, 'pg1')
    const texts = listSelectedTextsForBook(db, bookId)
    expect(texts.length).toBeGreaterThanOrEqual(1)
    expect(texts.map((t) => t.id)).toContain(text.id)
  })
})
