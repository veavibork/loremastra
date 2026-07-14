/**
 * The pre-kickoff dual-pass's second half: a separate Editor generation using
 * EDITOR_SETUP_WORLDBOOK, whose raw bracket-tagged output IS the visible log message (the
 * player sees it and it gets highlighted client-side) — not a hidden side-channel the way the
 * old tool-calling extraction pass was. Regex-extracts blocks from its own output immediately
 * after landing; zero blocks found is a normal outcome, not an error.
 */
import type Database from 'better-sqlite3'
import { finishJob } from '../../db/job-store.js'
import { getText, fillTextGeneration } from '../../db/text-store.js'
import { getPage } from '../../db/page-store.js'
import { getBookByType } from '../../db/book-store.js'
import { getGlobalDb } from '../../db/global-db.js'
import { getDecryptedFeatherlessKey } from '../../db/user-store.js'
import { getAgentProfile } from '../../services/agent-config.js'
import { buildSetupConversation } from '../../services/history.js'
import { applyExtractedWorldbookBlocks } from '../../services/worldbook/extraction.js'
import { EDITOR_SETUP_WORLDBOOK } from '../../prompts.js'
import { JobCancelledError, type ChatMessage } from '../../inference/featherless.js'
import { createLogger } from '../../inference/outbound-telemetry.js'
import { releaseSlot } from '../slots.js'
import { streamingModels, runningControllers, handleStreamingCancel } from '../cancel.js'
import { streamWithFallback } from '../provider-dispatch.js'
import { publishDone, publishError } from '../job-events.js'

export async function executeSetupWorldbookJob(
  db: Database.Database,
  userId: string,
  jobId: string,
  targetTextId: string,
  signal: AbortSignal,
  storyId: string,
): Promise<void> {
  const startedAt = Date.now()
  let worldbookId: string | undefined
  try {
    const targetText = getText(db, targetTextId)
    if (!targetText) throw new Error('target text no longer exists')
    const targetPage = getPage(db, targetText.pageId)
    if (!targetPage) throw new Error('target page no longer exists')

    const worldbook = getBookByType(db, 'worldbook')
    if (!worldbook) throw new Error('worldbook not found')
    worldbookId = worldbook.id

    const replyPage = targetPage.prevPageId ? getPage(db, targetPage.prevPageId) : null
    const replyText = replyPage?.selectedTextId ? getText(db, replyPage.selectedTextId) : null

    const conversation = buildSetupConversation(
      db,
      targetPage.bookId,
      replyPage?.prevPageId ?? null,
    )
    if (replyText?.genPackage)
      conversation.push({ role: 'assistant', content: replyText.genPackage })

    const worldbookMessages: ChatMessage[] = [
      { role: 'system', content: EDITOR_SETUP_WORLDBOOK },
      ...conversation,
    ]
    const featherlessKey = getDecryptedFeatherlessKey(getGlobalDb(), userId) ?? ''
    const { text: rawText, model } = await streamWithFallback(
      getAgentProfile(userId, 'editor'),
      featherlessKey,
      worldbookMessages,
      jobId,
      signal,
    )

    const tokenEstimate = Math.ceil(rawText.length / 4)
    fillTextGeneration(db, targetTextId, {
      genPackage: rawText,
      genMetrics: JSON.stringify({ tokenEstimate }),
    })

    try {
      applyExtractedWorldbookBlocks(db, worldbook.id, rawText)
    } catch (err) {
      createLogger({ jobId, storyId, jobType: 'setup-worldbook' }).error(
        'worldbook extraction failed, message still stands',
        { error: String(err) },
      )
    }

    finishJob(db, jobId, 'done', undefined, { model, tokenEstimate })
    publishDone(jobId, rawText)
  } catch (err) {
    if (err instanceof JobCancelledError) {
      handleStreamingCancel(db, jobId, targetTextId, startedAt, {
        onPartialCommit: (partial) => {
          if (!worldbookId) return
          try {
            applyExtractedWorldbookBlocks(db, worldbookId, partial)
          } catch (extractErr) {
            createLogger({ jobId, storyId, jobType: 'setup-worldbook' }).error(
              'worldbook extraction failed on truncated reply',
              { error: String(extractErr) },
            )
          }
        },
      })
    } else {
      const message = err instanceof Error ? err.message : String(err)
      finishJob(db, jobId, 'failed', message)
      publishError(jobId, message)
    }
  } finally {
    streamingModels.delete(jobId)
    releaseSlot(userId, jobId)
    runningControllers.delete(jobId)
  }
}
