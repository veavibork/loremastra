import type Database from 'better-sqlite3'
import { listChronologicalPages } from '../db/page-store.js'
import { getText, type TextRole, type TextRow } from '../db/text-store.js'
import { getBookByType } from '../db/book-store.js'
import {
  listWorldbookEntries,
  listContentEntries,
  type WorldbookEntry,
} from '../db/worldbook-store.js'
import { listStoryToDateSegments } from '../db/story-to-date-store.js'
import type { ChatMessage } from '../inference/featherless.js'
import { AUTHOR_SYSTEM_PROMPT, AUTHOR_KICKOFF_PROMPT } from '../prompts.js'
import {
  mergeStoryToDate,
  MIN_VERBOSE_IC_POSTS,
  resolvePageOrderForChainPost,
  resolveIcStartOrder,
  countChainPosts,
} from './story-to-date-engine.js'

const CHARS_PER_TOKEN_ESTIMATE = 4
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE)
}

function toChatRole(role: TextRole): 'user' | 'assistant' | 'system' {
  if (role === 'agent') return 'assistant'
  if (role === 'system') return 'system'
  return 'user'
}

function formatWorldbookEntry(entry: WorldbookEntry): string {
  return `[${entry.entryType.toUpperCase()}]\n${entry.content}`
}

export function assembleAuthorPrompt(
  db: Database.Database,
  userId: string,
  logbookId: string,
  fromPageId: string | null,
): ChatMessage[] {
  const allPages = listChronologicalPages(db, logbookId)
  const cutoffIdx = fromPageId
    ? allPages.findIndex((p) => p.id === fromPageId)
    : allPages.length - 1
  const cutoffOrder = cutoffIdx >= 0 ? cutoffIdx : allPages.length - 1
  if (!allPages.length) return []

  const worldbookHeaderLines: string[] = []
  const worldbookBook = getBookByType(db, 'worldbook')
  if (worldbookBook) {
    for (const entry of listWorldbookEntries(db, worldbookBook.id, { includeHidden: false })) {
      worldbookHeaderLines.push(formatWorldbookEntry(entry))
    }
  }

  const readySegments = listStoryToDateSegments(db, logbookId).filter(
    (s) => s.content?.trim() && !s.broken,
  )
  const storyToDateBlock = mergeStoryToDate(
    readySegments.map((s) => ({
      kind: s.kind,
      content: s.content!.trim(),
      coverageThroughPost: s.coverageThroughIcPost ?? 0,
      coveragePageId: s.coveragePageId,
    })),
  )

  let afterOrder = -1
  const lastSegment = readySegments.sort((a, b) => b.seq - a.seq)[0]
  if (lastSegment?.coveragePageId) {
    const idx = allPages.findIndex((p) => p.id === lastSegment.coveragePageId)
    if (idx >= 0) afterOrder = idx
  }

  const icStartOrder = resolveIcStartOrder(allPages)

  // Always keep a verbatim tail even when archives cover nearly the whole log.
  if (icStartOrder >= 0 && lastSegment?.coverageThroughIcPost != null) {
    const headPosts = countChainPosts(db, logbookId)
    if (headPosts > MIN_VERBOSE_IC_POSTS) {
      const tailStartPost = headPosts - MIN_VERBOSE_IC_POSTS + 1
      const tailOrder = resolvePageOrderForChainPost(allPages, icStartOrder, db, tailStartPost - 1)
      if (tailOrder >= icStartOrder && (afterOrder < 0 || tailOrder < afterOrder)) {
        afterOrder = tailOrder
      }
    }
  }

  interface HistoryEntry {
    order: number
    text: TextRow
  }
  const entries: HistoryEntry[] = []
  for (let order = 0; order <= cutoffOrder; order++) {
    const page = allPages[order]!
    if (icStartOrder >= 0 && order < icStartOrder) continue
    if (order <= afterOrder) continue
    if (page.hidden) continue
    if (!page.selectedTextId) continue
    const text = getText(db, page.selectedTextId)
    if (!text?.genPackage?.trim()) continue
    entries.push({ order, text })
  }

  const verboseMessages: ChatMessage[] = entries
    .sort((a, b) => a.order - b.order)
    .map((e) => ({ role: toChatRole(e.text.role), content: e.text.genPackage! }))

  const worldbookMessages: ChatMessage[] = worldbookHeaderLines.map((content) => ({
    role: 'system',
    content,
  }))
  const storyToDateMessages: ChatMessage[] = storyToDateBlock
    ? [{ role: 'system', content: storyToDateBlock }]
    : []

  return [
    { role: 'system', content: AUTHOR_SYSTEM_PROMPT },
    ...worldbookMessages,
    ...storyToDateMessages,
    ...verboseMessages,
  ]
}

export function assembleKickoffPrompt(
  db: Database.Database,
  worldbookBookId: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: AUTHOR_SYSTEM_PROMPT }]
  for (const entry of listContentEntries(db, worldbookBookId)) {
    messages.push({ role: 'system', content: formatWorldbookEntry(entry) })
  }
  messages.push({ role: 'system', content: AUTHOR_KICKOFF_PROMPT })
  return messages
}

/** Exported for story-to-date trigger estimation. */
export { estimateTokens }
