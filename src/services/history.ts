import type Database from 'better-sqlite3'
import { listChronologicalPages, getPage, type PageRow } from '../db/page-store.js'
import { getText, type TextRole, type TextRow } from '../db/text-store.js'
import { getBookByType } from '../db/book-store.js'
import {
  listWorldbookEntries,
  listContentEntries,
  type WorldbookEntry,
} from '../db/worldbook-store.js'
import { listStoryToDateSegments } from '../db/story-to-date-store.js'
import type { ChatMessage } from '../inference/featherless.js'
import { AUTHOR_SYSTEM_PROMPT, AUTHOR_KICKOFF_PROMPT, icProseSteeringNote } from '../prompts.js'
import {
  mergeStoryToDate,
  MIN_VERBOSE_IC_POSTS,
  resolvePageOrderForChainPost,
  resolveIcStartOrder,
  countChainPosts,
} from './story-to-date/engine.js'
import { getStoryState } from '../db/story-state-store.js'
import { resolveIcStartPageId } from './story-transition.js'
import { resolveRegisterFromContent } from './worldbook/assembly.js'

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

export type GuidanceIntent = 'regenerate' | 'continue'

export interface JobGuidance {
  text: string
  intent: GuidanceIntent
}

/**
 * Shared by both the Featherless (streamed, synchronous-await) and Horde (submit-then-poll)
 * prose paths — the prompt assembly itself doesn't care how the reply eventually comes back.
 */
export function buildProseHistory(
  db: Database.Database,
  userId: string,
  targetTextId: string,
  guidance?: JobGuidance,
): { history: ChatMessage[]; targetPage: PageRow } {
  const targetText = getText(db, targetTextId)
  if (!targetText) throw new Error('target text no longer exists')
  const targetPage = getPage(db, targetText.pageId)
  if (!targetPage) throw new Error('target page no longer exists')

  // The kickoff page (and any later Retry/Guided Retry of it) always generates from the
  // worldbook alone, never the setup conversation's chat log — checked by page identity,
  // not current phase, since phase moves on to "story" immediately after kickoff fires but
  // the opening post can still be regenerated any time after that.
  const icStartPageId = resolveIcStartPageId(db, targetPage.bookId)
  let history: ChatMessage[]
  if (icStartPageId && targetPage.id === icStartPageId) {
    const worldbook = getBookByType(db, 'worldbook')
    if (!worldbook) throw new Error('worldbook not found')
    history = assembleKickoffPrompt(db, worldbook.id)
  } else {
    history = assembleAuthorPrompt(db, userId, targetPage.bookId, targetPage.prevPageId)
  }

  const register = resolveRegisterFromContent(db)
  const steeringOpts = {
    register,
    tenseGuard: guidance?.intent === 'continue' || guidance?.intent === 'regenerate',
    guidance: guidance?.text,
    intent: guidance?.intent,
  }
  history = [...history, { role: 'system', content: icProseSteeringNote(steeringOpts) }]

  return { history, targetPage }
}

/**
 * Every turn in an OOC/setup conversation, verbatim (no tiering — these are short-lived), up
 * to and including the given page. Filters to hidden pages specifically — every setup/OOC page
 * is hidden the moment it's created, while in-character pages never are, so this is what scopes
 * the Editor's context to just OOC content even when it's interleaved with IC content on the
 * same page chain. `sincePageId`, when given, additionally scopes the *start* of the window —
 * this is what makes a post-kickoff "update session" fresh (no memory of earlier update
 * sessions) rather than reading the story's entire OOC history back to its original setup.
 */
export function buildSetupConversation(
  db: Database.Database,
  logbookId: string,
  uptoPageId: string | null,
  sincePageId?: string | null,
): ChatMessage[] {
  const pages = listChronologicalPages(db, logbookId).filter((p) => p.hidden)
  const sinceIdx = sincePageId ? pages.findIndex((p) => p.id === sincePageId) : -1
  const scoped = sinceIdx >= 0 ? pages.slice(sinceIdx) : pages
  const cutoffIdx = uptoPageId ? scoped.findIndex((p) => p.id === uptoPageId) : scoped.length - 1
  const historyPages = cutoffIdx >= 0 ? scoped.slice(0, cutoffIdx + 1) : scoped

  const messages: ChatMessage[] = []
  for (const page of historyPages) {
    if (!page.selectedTextId) continue
    const text = getText(db, page.selectedTextId)
    if (!text?.genPackage) continue
    messages.push({ role: text.role === 'agent' ? 'assistant' : 'user', content: text.genPackage })
  }
  return messages
}

/**
 * Read-only reference material for a post-kickoff update session: the in-character story so
 * far, folded into one system-role block rather than interleaved as raw user/assistant turns
 * (which would otherwise confuse the Editor's own OOC role alternation). Reuses
 * assembleAuthorPrompt's existing tiered history assembly rather than building a second one.
 */
export function buildIcContextBlock(
  db: Database.Database,
  userId: string,
  logbookId: string,
): ChatMessage | null {
  const currentPageId = getStoryState(db).currentPageId
  const icMessages = assembleAuthorPrompt(db, userId, logbookId, currentPageId).slice(1)
  if (!icMessages.length) return null
  const icLines = icMessages.map((m) => `[${m.role}] ${m.content}`).join('\n\n')
  return {
    role: 'system',
    content: `For reference, here is the in-character story so far (read-only — you are not continuing it, just aware of it):\n\n${icLines}`,
  }
}

/** Exported for story-to-date trigger estimation. */
export { estimateTokens }
