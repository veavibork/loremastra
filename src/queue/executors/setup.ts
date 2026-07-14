/**
 * The Editor's setup/update turn. Pre-kickoff, this is dual-pass: the conversational reply
 * (EDITOR_SETUP_PROMPT) lands here, then a second, separate worldbook-authoring pass
 * (EDITOR_SETUP_WORLDBOOK) is queued as its own job/page — matching those being two distinct
 * prompts in prompts.md. Post-kickoff "update session" turns are single-pass: EDITOR_UPDATE_PROMPT
 * already embeds the bracket schema inline, so the one reply is scanned for blocks directly,
 * no second page/job. If worldbook extraction fails, the conversational reply the user already
 * sees still stands — a background hiccup shouldn't erase what's already on screen.
 */
import type Database from 'better-sqlite3'
import { finishJob, createJob } from '../../db/job-store.js'
import { getText, fillTextGeneration } from '../../db/text-store.js'
import { getPage, setPageHidden } from '../../db/page-store.js'
import { getBookByType } from '../../db/book-store.js'
import { createPageWithText } from '../../db/content-store.js'
import { getGlobalDb } from '../../db/global-db.js'
import { getDecryptedFeatherlessKey } from '../../db/user-store.js'
import { getAgentProfile } from '../../services/agent-config.js'
import { buildSetupConversation, buildIcContextBlock } from '../../services/history.js'
import { applyExtractedWorldbookBlocks } from '../../services/worldbook/extraction.js'
import { resolveIcStartPageId } from '../../services/story-transition.js'
import { getStoryState } from '../../db/story-state-store.js'
import {
  EDITOR_SETUP_PROMPT,
  EDITOR_UPDATE_PROMPT,
  guidedRegenerateNote,
  guidedContinueNote,
} from '../../prompts.js'
import { JobCancelledError, type ChatMessage } from '../../inference/featherless.js'
import { createLogger } from '../../inference/outbound-telemetry.js'
import { releaseSlot } from '../slots.js'
import { releaseProseLane } from '../job-lanes.js'
import { streamingModels, runningControllers, handleStreamingCancel } from '../cancel.js'
import { streamWithFallback } from '../provider-dispatch.js'
import { publishDone, publishError, publishJobCreated } from '../job-events.js'

export type GuidanceIntent = 'regenerate' | 'continue'

export async function executeSetupJob(
  db: Database.Database,
  userId: string,
  jobId: string,
  targetTextId: string,
  signal: AbortSignal,
  storyId: string,
  guidance?: { text: string; intent: GuidanceIntent },
): Promise<void> {
  const startedAt = Date.now()
  let isUpdateSession = false
  let worldbookId: string | undefined
  try {
    const targetText = getText(db, targetTextId)
    if (!targetText) throw new Error('target text no longer exists')
    const targetPage = getPage(db, targetText.pageId)
    if (!targetPage) throw new Error('target page no longer exists')

    const worldbook = getBookByType(db, 'worldbook')
    if (!worldbook) throw new Error('worldbook not found')
    worldbookId = worldbook.id

    const { oocSessionStartPageId } = getStoryState(db)
    isUpdateSession = !!resolveIcStartPageId(db, targetPage.bookId)

    let conversation: ChatMessage[]
    const editorMessages: ChatMessage[] = []
    if (isUpdateSession) {
      editorMessages.push({ role: 'system', content: EDITOR_UPDATE_PROMPT })
      const icContextBlock = buildIcContextBlock(db, userId, targetPage.bookId)
      if (icContextBlock) editorMessages.push(icContextBlock)
      conversation = buildSetupConversation(
        db,
        targetPage.bookId,
        targetPage.prevPageId,
        oocSessionStartPageId,
      )
    } else {
      editorMessages.push({ role: 'system', content: EDITOR_SETUP_PROMPT })
      conversation = buildSetupConversation(db, targetPage.bookId, targetPage.prevPageId)
    }
    editorMessages.push(...conversation)

    if (guidance) {
      const content =
        guidance.intent === 'continue'
          ? guidedContinueNote(guidance.text, 'conversation')
          : guidedRegenerateNote(guidance.text)
      editorMessages.push({ role: 'system', content })
    }

    const featherlessKey = getDecryptedFeatherlessKey(getGlobalDb(), userId) ?? ''
    const { text: reply, model } = await streamWithFallback(
      getAgentProfile(userId, 'editor'),
      featherlessKey,
      editorMessages,
      jobId,
      signal,
    )

    const tokenEstimate = Math.ceil(reply.length / 4)
    fillTextGeneration(db, targetTextId, {
      genPackage: reply,
      genMetrics: JSON.stringify({ tokenEstimate }),
    })

    let followUp: { jobId: string; pageId: string } | undefined
    if (isUpdateSession) {
      // Single-pass: EDITOR_UPDATE_PROMPT's own reply may itself contain bracket blocks.
      try {
        applyExtractedWorldbookBlocks(db, worldbook.id, reply)
      } catch (err) {
        createLogger({ jobId, storyId, jobType: 'setup' }).error(
          'worldbook extraction failed, reply still stands',
          { error: String(err) },
        )
      }
    } else {
      // Dual-pass: queue a separate worldbook-authoring pass as its own visible message.
      try {
        const { page: worldbookPage, text: worldbookText } = createPageWithText(db, {
          bookId: targetPage.bookId,
          prevPageId: targetPage.id,
          role: 'agent',
        })
        setPageHidden(db, worldbookPage.id, true)
        const worldbookJob = createJob(db, {
          targetTextId: worldbookText.id,
          jobType: 'setup-worldbook',
          slotCost: getAgentProfile(userId, 'editor').concurrencyCost,
          priority: 10,
        })
        publishJobCreated(worldbookJob.id, worldbookJob.jobType, storyId)
        followUp = { jobId: worldbookJob.id, pageId: worldbookPage.id }
      } catch (err) {
        createLogger({ jobId, storyId, jobType: 'setup' }).error(
          'failed to queue worldbook-authoring pass, reply still stands',
          { error: String(err) },
        )
      }
    }

    finishJob(db, jobId, 'done', undefined, { model, tokenEstimate })
    publishDone(jobId, reply, followUp)
  } catch (err) {
    if (err instanceof JobCancelledError) {
      handleStreamingCancel(db, jobId, targetTextId, startedAt, {
        onPartialCommit: (partial) => {
          if (isUpdateSession && worldbookId) {
            try {
              applyExtractedWorldbookBlocks(db, worldbookId, partial)
            } catch (extractErr) {
              createLogger({ jobId, storyId, jobType: 'setup' }).error(
                'worldbook extraction failed on truncated reply',
                { error: String(extractErr) },
              )
            }
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
    releaseProseLane()
  }
}
