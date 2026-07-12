import type Database from 'better-sqlite3'
import { findHeadPageId, getPage } from '../db/page-store.js'
import { getText, type TextRole } from '../db/text-store.js'
import { buildChainPostIndex } from './post-index.js'

export interface LogEntry {
  pageId: string
  textId: string | null
  role: TextRole | 'user'
  content: string | null
  hidden: boolean
  createdAt: string | null
  genMetrics: string | null
  genExtract: string | null
  compressMetrics: string | null
  /** Absolute chain post from kickoff (hidden turns included); null for setup or empty pages. */
  icPostNumber: number | null
}

export interface LogViewPage {
  entries: LogEntry[]
  /** True when older history exists beyond what's returned — the log is paginated, not the whole chain. */
  hasMore: boolean
}

export interface LogViewOpts {
  /** Cap on entries walked back from the start point; ignored when throughPageId is set. */
  limit?: number
  /** Resume an earlier "load more" batch — walk starts strictly before this page. */
  beforePageId?: string
  /** Incremental-refresh cursor — walk from head and stop once this page (inclusive) is collected. */
  throughPageId?: string
}

/** findHeadPageId is fork-aware (Milestone D); walking backward via prev_page_id from its result is always the correct active-path history regardless of forks, since prev_page_id is single/unambiguous going backward. */
export function buildLogView(
  db: Database.Database,
  logbookId: string,
  opts?: LogViewOpts,
): LogViewPage {
  const postByPage = new Map(
    buildChainPostIndex(db, logbookId).map((e) => [e.pageId, e.postNumber]),
  )

  const entries: LogEntry[] = []
  let hasMore = false
  let currentId: string | null = opts?.beforePageId
    ? (getPage(db, opts.beforePageId)?.prevPageId ?? null)
    : findHeadPageId(db, logbookId)

  while (currentId) {
    const page = getPage(db, currentId)
    if (!page) break

    if (opts?.limit !== undefined && !opts.throughPageId && entries.length >= opts.limit) {
      hasMore = true
      break
    }

    const text = page.selectedTextId ? getText(db, page.selectedTextId) : null
    entries.unshift({
      pageId: page.id,
      textId: text?.id ?? null,
      role: text?.role ?? 'user',
      content: text?.genPackage ?? null,
      hidden: page.hidden,
      createdAt: text?.createdAt ?? null,
      genMetrics: text?.genMetrics ?? null,
      genExtract: text?.genExtract ?? null,
      compressMetrics: text?.compressMetrics ?? null,
      icPostNumber: postByPage.get(page.id) ?? null,
    })

    if (opts?.throughPageId && page.id === opts.throughPageId) {
      hasMore = page.prevPageId !== null
      break
    }

    currentId = page.prevPageId
  }

  return { entries, hasMore }
}
