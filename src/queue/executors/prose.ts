/** Main prose generation executor — dispatches an Author-tier streaming completion. */
import type Database from 'better-sqlite3'
import { finishJob, setJobInputTokenEstimate } from '../../db/job-store.js'
import { fillTextGeneration } from '../../db/text-store.js'
import { type PageRow } from '../../db/page-store.js'
import { getBookByType } from '../../db/book-store.js'
import { getGlobalDb } from '../../db/global-db.js'
import { getDecryptedFeatherlessKey } from '../../db/user-store.js'
import { getAgentProfile } from '../../services/agent-config.js'
import { buildProseHistory } from '../../services/history.js'
import {
  REASONING_ASSISTANT_PREFILL,
  isReasoningModel,
  estimateMessageTokens,
  JobCancelledError,
} from '../../inference/featherless.js'
import { releaseSlot } from '../slots.js'
import { streamingModels, runningControllers, handleStreamingCancel } from '../cancel.js'
import { streamWithFallback } from '../provider-dispatch.js'
import { publishDone, publishError } from '../job-events.js'
import { maybeQueueStoryNameJob, maybeEnqueueStoryToDateJob } from '../helpers.js'
import type { GuidanceIntent } from './setup.js'
import type { GenerationOptions } from '../../services/settings-space-registry.js'
import type { AgentProfile } from '../../config.js'

function applyGenerationOptions(
  profile: AgentProfile,
  options?: GenerationOptions,
): { profile: AgentProfile; moodFragment?: string; chatTemplateKwargs?: Record<string, unknown> } {
  if (!options) return { profile }
  const chatTemplateKwargs: Record<string, unknown> = {}
  if (options.effort?.enableThinking !== undefined) {
    chatTemplateKwargs.enable_thinking = options.effort.enableThinking
  }
  if (options.effort?.thinkingBudget !== undefined) {
    chatTemplateKwargs.thinking_budget = options.effort.thinkingBudget
  }
  // Length toggle: 0/absent = "Auto" (no override, agent default). Clamped to the agent's
  // configured responseLimit because the story-to-date window is budgeted against
  // contextLimit - responseLimit using the configured value — a larger per-post override
  // could overflow the context window on long stories.
  let effectiveProfile = profile
  if (options.responseLimit && options.responseLimit > 0) {
    effectiveProfile = {
      ...profile,
      responseLimit: Math.min(options.responseLimit, profile.responseLimit),
    }
  }
  // Mood / param / model toggles still disabled — Author uses agent-config defaults for those.
  return {
    profile: effectiveProfile,
    chatTemplateKwargs: Object.keys(chatTemplateKwargs).length ? chatTemplateKwargs : undefined,
  }
}

export async function executeProseJob(
  db: Database.Database,
  userId: string,
  jobId: string,
  targetTextId: string,
  signal: AbortSignal,
  storyId: string,
  guidance?: { text: string; intent: GuidanceIntent },
  genOptions?: GenerationOptions,
): Promise<void> {
  const startedAt = Date.now()
  let targetPage: PageRow | undefined
  try {
    const built = buildProseHistory(db, userId, targetTextId, guidance)
    targetPage = built.targetPage
    const { history } = built
    const { profile, moodFragment, chatTemplateKwargs } = applyGenerationOptions(
      getAgentProfile(userId, 'author'),
      genOptions,
    )
    let finalHistory = history
    if (moodFragment) {
      finalHistory = [...history, { role: 'system', content: moodFragment }]
    }
    const inferenceMessages = isReasoningModel(profile.model)
      ? [...finalHistory, { role: 'assistant' as const, content: REASONING_ASSISTANT_PREFILL }]
      : finalHistory
    setJobInputTokenEstimate(db, jobId, estimateMessageTokens(inferenceMessages))
    const featherlessKey = getDecryptedFeatherlessKey(getGlobalDb(), userId) ?? ''
    const { text: fullText, model } = await streamWithFallback(
      profile,
      featherlessKey,
      finalHistory,
      jobId,
      signal,
      chatTemplateKwargs,
      isReasoningModel(profile.model),
    )

    // chars/4 is the same rough estimate used for prompt budgeting elsewhere (see history.ts) —
    // not a real tokenizer, good enough for the Logs telemetry view's ballpark numbers.
    const tokenEstimate = Math.ceil(fullText.length / 4)
    const metrics: Record<string, unknown> = { elapsedMs: Date.now() - startedAt, tokenEstimate }
    if (genOptions) metrics.toggles = genOptions
    fillTextGeneration(db, targetTextId, {
      genPackage: fullText,
      genMetrics: JSON.stringify(metrics),
    })
    maybeQueueStoryNameJob(db, userId, storyId, targetPage, targetTextId)
    const logbook = getBookByType(db, 'logbook')
    if (logbook) maybeEnqueueStoryToDateJob(db, userId, storyId, logbook.id)
    finishJob(db, jobId, 'done', undefined, {
      model,
      tokenEstimate,
      elapsedMs: Date.now() - startedAt,
    })
    publishDone(jobId, fullText)
  } catch (err) {
    if (err instanceof JobCancelledError) {
      handleStreamingCancel(db, jobId, targetTextId, startedAt, {
        genOptions,
        onPartialCommit: () => {
          if (!targetPage) return
          maybeQueueStoryNameJob(db, userId, storyId, targetPage, targetTextId)
          const logbook = getBookByType(db, 'logbook')
          if (logbook) maybeEnqueueStoryToDateJob(db, userId, storyId, logbook.id)
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
