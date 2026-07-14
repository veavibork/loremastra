/**
 * Business logic for story operations — extracted from routes/stories.ts so route
 * handlers are thin HTTP adapters (parse request → call service → format response).
 *
 * Each function takes a storyDb handle + the parameters it needs, performs the
 * multi-step DB transaction (page creation, state mutation, history recording,
 * job creation), and returns a result object. Routes format the HTTP response.
 */
import type Database from 'better-sqlite3'
import { getGlobalDb } from '../db/global-db.js'
import { getStoryDb, closeStoryDb } from '../db/story-db.js'
import { createStory, getStory, deleteStory, DEFAULT_STORY_NAME } from '../db/story-store.js'
import { createBook, getBookByType } from '../db/book-store.js'
import { findHeadPageId, getPage, setPageHidden } from '../db/page-store.js'
import { createPageWithText, createRetryText } from '../db/content-store.js'
import { createJob } from '../db/job-store.js'
import { getText } from '../db/text-store.js'
import {
  getStoryState,
  setStoryPhase,
  setCurrentPageId,
  setOocSessionStartPageId,
} from '../db/story-state-store.js'
import { recordHistoryEvent, canUndoHistory, canRedoHistory } from '../db/history-store.js'
import { listChronologicalPages } from '../db/page-store.js'
import {
  trackStoryDb,
  untrackStoryDb,
  setJobGuidance,
  setJobGenerationOptions,
} from '../queue/pipeline-runner.js'
import { publishJobCreated } from '../queue/job-events.js'
import { enqueueEligibleStoryToDateJob } from './story-to-date/index.js'
import { onCanonicalTextChangedForStory } from './context/invalidation.js'
import { finalizeSetup } from './story-transition.js'
import { getAgentProfile } from './agent-config.js'
import type { GenerationOptions } from './settings-space-registry.js'
import { EDITOR_SETUP_OPENING } from '../prompts.js'
import { unlinkSync } from 'node:fs'

/** Open (or reuse) a story's DB and register it with the pipeline runner for job scanning. */
export function openTrackedStoryDb(storyId: string): ReturnType<typeof getStoryDb> {
  const db = getStoryDb(storyId)
  trackStoryDb(storyId, db)
  return db
}

export interface CreateStoryResult {
  story: ReturnType<typeof createStory>
}

export function createStoryWithBooks(userId: string, name?: string): CreateStoryResult {
  const globalDb = getGlobalDb()
  const story = createStory(globalDb, {
    ownerUserId: userId,
    name: name?.trim() || DEFAULT_STORY_NAME,
  })

  const storyDb = openTrackedStoryDb(story.id)
  const gameBook = createBook(storyDb, { bookType: 'story' })
  const logbook = createBook(storyDb, { bookType: 'logbook', parentBookId: gameBook.id })
  createBook(storyDb, { bookType: 'worldbook', parentBookId: gameBook.id })

  // The Editor "speaks first" — a canned opening line, no inference call, before the user
  // has typed anything. See EDITOR_SETUP_OPENING in src/prompts.ts.
  const { page: openingPage } = createPageWithText(storyDb, {
    bookId: logbook.id,
    role: 'agent',
    genPackage: EDITOR_SETUP_OPENING,
  })
  setPageHidden(storyDb, openingPage.id, true)

  return { story }
}

export async function deleteStoryWithFiles(storyId: string): Promise<void> {
  const globalDb = getGlobalDb()
  const story = getStory(globalDb, storyId)
  if (!story) return

  closeStoryDb(storyId)
  untrackStoryDb(storyId)
  deleteStory(globalDb, storyId)

  // The DB row above is the authoritative delete — it already succeeded by this point. WAL mode's
  // -wal/-shm sidecars can stay briefly locked on Windows even after close() returns (checkpoint
  // flush, AV scan, etc.), so a stubborn file is retried a few times and then just logged rather
  // than failing a request whose real work is already done.
  for (const suffix of ['', '-wal', '-shm']) {
    for (let attempt = 0; ; attempt++) {
      try {
        unlinkSync(story.filePath + suffix)
        break
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') break
        if (code === 'EBUSY' && attempt < 4) {
          await new Promise((resolve) => setTimeout(resolve, 100))
          continue
        }
        console.error(`[stories] failed to delete story file ${story.filePath}${suffix}:`, err)
        break
      }
    }
  }
}

export interface PostMessageResult {
  userPageId: string
  agentPageId: string
  jobId: string
}

export function postMessage(
  storyDb: Database.Database,
  userId: string,
  storyId: string,
  content: string,
  generationOptions?: GenerationOptions,
): PostMessageResult | { error: string; status: 400 | 404 } {
  if (getStoryState(storyDb).phase !== 'active') {
    return { error: "story hasn't reached story phase yet", status: 400 }
  }
  const logbook = getBookByType(storyDb, 'logbook')
  if (!logbook) return { error: 'logbook not found', status: 404 }

  // Attach at the current position (which is the head unless the user has undone/rewound) —
  // submitting new content from an earlier point creates a sibling fork, per loremaster.md's
  // Post Controls: non-destructive, nothing after the current position is touched or lost.
  const attachAt = getStoryState(storyDb).currentPageId ?? findHeadPageId(storyDb, logbook.id)

  const { page: userPage, text: _userText } = createPageWithText(storyDb, {
    bookId: logbook.id,
    prevPageId: attachAt,
    role: 'user',
    genPackage: content,
  })

  const { page: agentPage, text: agentText } = createPageWithText(storyDb, {
    bookId: logbook.id,
    prevPageId: userPage.id,
    role: 'agent',
  })
  setCurrentPageId(storyDb, null)
  recordHistoryEvent(storyDb, {
    kind: 'page',
    pageId: agentPage.id,
    fromValue: attachAt,
    toValue: agentPage.id,
  })

  const job = createJob(storyDb, {
    targetTextId: agentText.id,
    jobType: 'prose',
    slotCost: getAgentProfile(userId, 'author').concurrencyCost,
    priority: 10,
  })
  publishJobCreated(job.id, job.jobType, storyId)
  if (generationOptions) setJobGenerationOptions(job.id, generationOptions)
  enqueueEligibleStoryToDateJob(storyDb, userId, logbook.id, storyId)

  return { userPageId: userPage.id, agentPageId: agentPage.id, jobId: job.id }
}

export interface RetryResult {
  jobId: string
  pageId: string
  textId: string
}

export function retryPost(
  storyDb: Database.Database,
  userId: string,
  storyId: string,
  pageId: string,
  guidance?: string,
  generationOptions?: GenerationOptions,
): RetryResult | { error: string; status: 400 | 404 } {
  const page = getPage(storyDb, pageId)
  if (!page) return { error: 'page not found', status: 404 }
  if (!page.selectedTextId) return { error: 'page has no current text', status: 400 }
  const currentText = getText(storyDb, page.selectedTextId)
  if (!currentText) return { error: 'current text not found', status: 404 }
  if (currentText.role !== 'agent') return { error: 'only agent posts can be retried', status: 400 }

  const isSetupPage = page.hidden

  const newText = createRetryText(storyDb, {
    pageId,
    priorTextId: currentText.id,
    role: 'agent',
  })
  recordHistoryEvent(storyDb, {
    kind: 'text',
    pageId,
    fromValue: currentText.id,
    toValue: newText.id,
  })
  onCanonicalTextChangedForStory(storyDb, userId, storyId, pageId)
  const job = createJob(storyDb, {
    targetTextId: newText.id,
    jobType: isSetupPage ? 'setup' : 'prose',
    slotCost: getAgentProfile(userId, isSetupPage ? 'editor' : 'author').concurrencyCost,
    priority: 10,
  })
  publishJobCreated(job.id, job.jobType, storyId)
  if (guidance?.trim()) setJobGuidance(job.id, guidance.trim(), 'regenerate')
  if (!isSetupPage && generationOptions) setJobGenerationOptions(job.id, generationOptions)

  return { jobId: job.id, pageId, textId: newText.id }
}

export interface EditResult {
  textId: string
}

export function editPost(
  storyDb: Database.Database,
  userId: string,
  storyId: string,
  pageId: string,
  content: string,
): EditResult | { error: string; status: 400 | 404 } {
  const page = getPage(storyDb, pageId)
  if (!page) return { error: 'page not found', status: 404 }
  if (!page.selectedTextId) return { error: 'page has no current text', status: 400 }
  const currentText = getText(storyDb, page.selectedTextId)
  if (!currentText) return { error: 'current text not found', status: 404 }

  const newText = createRetryText(storyDb, {
    pageId,
    priorTextId: currentText.id,
    role: currentText.role,
    genPackage: content,
  })
  recordHistoryEvent(storyDb, {
    kind: 'text',
    pageId,
    fromValue: currentText.id,
    toValue: newText.id,
  })
  onCanonicalTextChangedForStory(storyDb, userId, storyId, pageId)

  return { textId: newText.id }
}

export interface ContinueResult {
  agentPageId: string
  jobId: string
}

export function continueStory(
  storyDb: Database.Database,
  userId: string,
  storyId: string,
  guidance?: string,
  generationOptions?: GenerationOptions,
): ContinueResult | { error: string; status: 400 | 404 } {
  const phase = getStoryState(storyDb).phase
  if (phase !== 'setup' && phase !== 'active') {
    return { error: "story isn't in a phase that can continue", status: 400 }
  }
  const logbook = getBookByType(storyDb, 'logbook')
  if (!logbook) return { error: 'logbook not found', status: 404 }

  const attachAt = getStoryState(storyDb).currentPageId ?? findHeadPageId(storyDb, logbook.id)
  const isSetupContinuation =
    phase === 'setup' || !!(attachAt && getPage(storyDb, attachAt)?.hidden)

  const { page, text } = createPageWithText(storyDb, {
    bookId: logbook.id,
    prevPageId: attachAt,
    role: 'agent',
  })
  if (isSetupContinuation) setPageHidden(storyDb, page.id, true)
  setCurrentPageId(storyDb, null)
  recordHistoryEvent(storyDb, {
    kind: 'page',
    pageId: page.id,
    fromValue: attachAt,
    toValue: page.id,
  })

  const job = createJob(storyDb, {
    targetTextId: text.id,
    jobType: isSetupContinuation ? 'setup' : 'prose',
    slotCost: getAgentProfile(userId, isSetupContinuation ? 'editor' : 'author').concurrencyCost,
    priority: 10,
  })
  publishJobCreated(job.id, job.jobType, storyId)
  if (guidance?.trim()) setJobGuidance(job.id, guidance.trim(), 'continue')
  if (!isSetupContinuation && generationOptions) setJobGenerationOptions(job.id, generationOptions)

  return { agentPageId: page.id, jobId: job.id }
}

export interface SetupMessageResult {
  userPageId: string
  agentPageId: string
  jobId: string
}

export function postSetupMessage(
  storyDb: Database.Database,
  userId: string,
  storyId: string,
  content: string,
): SetupMessageResult | { error: string; status: 400 | 404 } {
  if (!content.trim()) return { error: 'content is required', status: 400 }
  const logbook = getBookByType(storyDb, 'logbook')
  if (!logbook) return { error: 'logbook not found', status: 404 }

  const attachAt = getStoryState(storyDb).currentPageId ?? findHeadPageId(storyDb, logbook.id)
  const { page: userPage, text: _userText } = createPageWithText(storyDb, {
    bookId: logbook.id,
    prevPageId: attachAt,
    role: 'user',
    genPackage: content,
  })
  setPageHidden(storyDb, userPage.id, true)

  const { page: agentPage, text: agentText } = createPageWithText(storyDb, {
    bookId: logbook.id,
    prevPageId: userPage.id,
    role: 'agent',
  })
  setPageHidden(storyDb, agentPage.id, true)
  setCurrentPageId(storyDb, null)
  recordHistoryEvent(storyDb, {
    kind: 'page',
    pageId: agentPage.id,
    fromValue: attachAt,
    toValue: agentPage.id,
  })

  const job = createJob(storyDb, {
    targetTextId: agentText.id,
    jobType: 'setup',
    slotCost: getAgentProfile(userId, 'editor').concurrencyCost,
    priority: 10,
  })
  publishJobCreated(job.id, job.jobType, storyId)
  return { userPageId: userPage.id, agentPageId: agentPage.id, jobId: job.id }
}

export interface KickoffResult {
  agentPageId: string
  jobId: string
}

export function kickoffStory(
  storyDb: Database.Database,
  userId: string,
  storyId: string,
): KickoffResult | { error: string; status: 400 | 404 } {
  if (getStoryState(storyDb).phase !== 'setup')
    return { error: 'story is not in setup phase', status: 400 }

  const logbook = getBookByType(storyDb, 'logbook')
  if (!logbook) return { error: 'logbook not found', status: 404 }

  const attachAt = getStoryState(storyDb).currentPageId ?? findHeadPageId(storyDb, logbook.id)
  const { page, text } = createPageWithText(storyDb, {
    bookId: logbook.id,
    prevPageId: attachAt,
    role: 'agent',
  })

  finalizeSetup(storyDb, logbook.id, page.id)
  setStoryPhase(storyDb, 'active')
  setCurrentPageId(storyDb, null)
  recordHistoryEvent(storyDb, {
    kind: 'page',
    pageId: page.id,
    fromValue: attachAt,
    toValue: page.id,
  })

  const job = createJob(storyDb, {
    targetTextId: text.id,
    jobType: 'prose',
    slotCost: getAgentProfile(userId, 'author').concurrencyCost,
    priority: 10,
  })
  publishJobCreated(job.id, job.jobType, storyId)
  return { agentPageId: page.id, jobId: job.id }
}

export function startOocSession(
  storyDb: Database.Database,
): { ok: true } | { error: string; status: 400 | 404 } {
  if (getStoryState(storyDb).phase !== 'active')
    return { error: "story hasn't reached story phase yet", status: 400 }

  const logbook = getBookByType(storyDb, 'logbook')
  if (!logbook) return { error: 'logbook not found', status: 404 }

  const hiddenPages = listChronologicalPages(storyDb, logbook.id).filter((p) => p.hidden)
  const boundaryPageId = hiddenPages.length > 0 ? hiddenPages[hiddenPages.length - 1].id : null
  setOocSessionStartPageId(storyDb, boundaryPageId)

  return { ok: true }
}

export interface PositionResponse {
  currentPageId: string | null
  headPageId: string | null
  atHead: boolean
  canUndo: boolean
  canRedo: boolean
}

export function currentPosition(storyDb: ReturnType<typeof getStoryDb>): PositionResponse {
  const logbook = getBookByType(storyDb, 'logbook')
  const headPageId = logbook ? findHeadPageId(storyDb, logbook.id) : null
  const currentPageId = getStoryState(storyDb).currentPageId ?? headPageId
  return {
    currentPageId,
    headPageId,
    atHead: currentPageId === headPageId,
    canUndo: canUndoHistory(storyDb),
    canRedo: canRedoHistory(storyDb),
  }
}
