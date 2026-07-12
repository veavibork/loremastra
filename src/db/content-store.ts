import type Database from 'better-sqlite3'
import { createPage, getPage, setSelectedText, type PageRow } from './page-store.js'
import { createText, type TextRole, type TextRow } from './text-store.js'

/** A user post, an author reply, a worldbook entry, a setup turn — all start as one page plus its first text. */
export function createPageWithText(
  db: Database.Database,
  input: {
    bookId: string
    prevPageId?: string | null
    role: TextRole
    sourcePageId?: string | null
    genRequest?: string | null
    genPackage?: string | null
  },
): { page: PageRow; text: TextRow } {
  const run = db.transaction(() => {
    const page = createPage(db, { bookId: input.bookId, prevPageId: input.prevPageId ?? null })
    const text = createText(db, {
      pageId: page.id,
      role: input.role,
      sourcePageId: input.sourcePageId ?? null,
      genRequest: input.genRequest ?? null,
      genPackage: input.genPackage ?? null,
    })
    setSelectedText(db, page.id, text.id)
    return { page: getPage(db, page.id)!, text }
  })
  return run()
}

/** Retry, guided retry, and edit are the same operation: a new text version under the same page, becoming canonical. */
export function createRetryText(
  db: Database.Database,
  input: {
    pageId: string
    priorTextId: string
    role: TextRole
    genRequest?: string | null
    genPackage?: string | null
  },
): TextRow {
  const run = db.transaction(() => {
    const text = createText(db, {
      pageId: input.pageId,
      priorTextId: input.priorTextId,
      role: input.role,
      genRequest: input.genRequest ?? null,
      genPackage: input.genPackage ?? null,
    })
    setSelectedText(db, input.pageId, text.id)
    return text
  })
  return run()
}
