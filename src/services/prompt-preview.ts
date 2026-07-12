import type Database from 'better-sqlite3'
import { assembleAuthorPrompt, estimateTokens } from './history.js'
import { getAgentProfile } from './agent-config.js'
import { STORY_TO_DATE_TRIGGER } from './story-to-date.js'
import { buildChainPostIndex } from './post-index.js'

export interface PromptPreviewMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  tokenEstimate: number
  /** Absolute chain post number for verbose user/assistant turns in Author prompt. */
  icPostNumber: number | null
  /** Running sum of tokenEstimate through this message (inclusive). */
  cumulativeTokens: number
}

export interface PromptPreview {
  messages: PromptPreviewMessage[]
  totalTokens: number
  usableBudget: number
  storyToDateTriggerAt: number
}

export function buildPromptPreview(
  db: Database.Database,
  userId: string,
  logbookId: string,
  fromPageId: string | null,
): PromptPreview {
  const messages = assembleAuthorPrompt(db, userId, logbookId, fromPageId)
  const author = getAgentProfile(userId, 'author')
  const usableBudget = author.contextLimit - author.responseLimit
  const storyToDateTriggerAt = Math.floor(usableBudget * STORY_TO_DATE_TRIGGER)

  const visiblePostNumbers = buildChainPostIndex(db, logbookId)
    .filter((e) => !e.hidden)
    .map((e) => e.postNumber)

  let cumulative = 0
  let verboseIdx = 0
  const enriched: PromptPreviewMessage[] = messages.map((m) => {
    const content = m.content ?? ''
    const tokenEstimate = estimateTokens(content)
    cumulative += tokenEstimate

    let icPostNumber: number | null = null
    if (m.role === 'user' || m.role === 'assistant') {
      icPostNumber = visiblePostNumbers[verboseIdx] ?? null
      verboseIdx++
    }

    return {
      role: m.role as PromptPreviewMessage['role'],
      content,
      tokenEstimate,
      icPostNumber,
      cumulativeTokens: cumulative,
    }
  })

  return {
    messages: enriched,
    totalTokens: cumulative,
    usableBudget,
    storyToDateTriggerAt,
  }
}
