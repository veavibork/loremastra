/**
 * Canonical absolute post numbering from the first visible IC page on the active chain.
 * Every page with selected prose counts — including hidden OOC/guide turns after post 1 —
 * so Logs, Memory, Archives, and Author assembly share one index (gaps only when UI hides rows).
 */
import type Database from 'better-sqlite3'
import { listChronologicalPages, type PageRow } from '../db/page-store.js'
import { getText, type TextRole } from '../db/text-store.js'
import { resolveIcStartPageId } from './story-transition.js'

export interface ChainPostEntry {
  /** 1-based from first visible IC page; stable across hidden/visible filtering. */
  postNumber: number
  pageId: string
  hidden: boolean
  role: TextRole
  content: string
}

export function resolveIcStartOrder(pages: PageRow[]): number {
  return pages.findIndex((p) => !p.hidden)
}

export function buildChainPostIndex(db: Database.Database, logbookId: string): ChainPostEntry[] {
  const pages = listChronologicalPages(db, logbookId)
  const startOrder = resolveIcStartOrder(pages)
  if (startOrder < 0) return []

  const entries: ChainPostEntry[] = []
  let postNumber = 0
  for (let order = startOrder; order < pages.length; order++) {
    const page = pages[order]!
    if (!page.selectedTextId) continue
    const text = getText(db, page.selectedTextId)
    if (!text?.genPackage?.trim()) continue
    postNumber++
    entries.push({
      postNumber,
      pageId: page.id,
      hidden: page.hidden,
      role: text.role,
      content: text.genPackage.trim(),
    })
  }
  return entries
}

export function countChainPosts(db: Database.Database, logbookId: string): number {
  return buildChainPostIndex(db, logbookId).length
}

export function resolveChainPostNumber(
  db: Database.Database,
  logbookId: string,
  pageId: string,
): number | null {
  return buildChainPostIndex(db, logbookId).find((e) => e.pageId === pageId)?.postNumber ?? null
}

export function resolvePageIdForChainPost(
  db: Database.Database,
  logbookId: string,
  postNumber: number,
): string | null {
  if (postNumber <= 0) return null
  return buildChainPostIndex(db, logbookId).find((e) => e.postNumber === postNumber)?.pageId ?? null
}

/** Index in `pages` (full chain list) of the page for `postNumber`. */
export function resolvePageOrderForChainPost(
  pages: PageRow[],
  icStartOrder: number,
  db: Database.Database,
  postNumber: number,
): number {
  if (postNumber <= 0 || icStartOrder < 0) return icStartOrder - 1
  let n = 0
  for (let order = 0; order < pages.length; order++) {
    if (order < icStartOrder) continue
    const page = pages[order]!
    if (!page.selectedTextId) continue
    const text = getText(db, page.selectedTextId)
    if (!text?.genPackage?.trim()) continue
    n++
    if (n >= postNumber) return order
  }
  return pages.length - 1
}

/** @deprecated Use resolveChainPostNumber — same absolute semantics. */
export const resolveIcPostNumber = resolveChainPostNumber

/** @deprecated Use countChainPosts — includes hidden posts. */
export const countIcPosts = countChainPosts

/** @deprecated Use resolvePageIdForChainPost. */
export const resolvePageIdForIcPost = resolvePageIdForChainPost

/** @deprecated Use resolvePageOrderForChainPost. */
export const resolvePageOrderForIcPost = resolvePageOrderForChainPost

export { resolveIcStartPageId }
