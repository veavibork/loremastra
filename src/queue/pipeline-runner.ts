import type Database from 'better-sqlite3'
import {
  claimNextJob,
  createJob,
  finishJob,
  cancelJob,
  setHordeRequestId,
  setJobModel,
  setJobInputTokenEstimate,
  listRunningHordeJobs,
  type JobRow,
  type JobType,
} from '../db/job-store.js'
import { fillTextGeneration, getText } from '../db/text-store.js'
import { getPage, setPageHidden, type PageRow } from '../db/page-store.js'
import { createPageWithText } from '../db/content-store.js'
import { getBookByType } from '../db/book-store.js'
import { getStoryState } from '../db/story-state-store.js'
import { getGlobalDb } from '../db/global-db.js'
import { getStory, renameStory, DEFAULT_STORY_NAME } from '../db/story-store.js'
import { tryAcquireSlot, releaseSlot } from './slots.js'
import {
  refreshWorkerLaneLimits,
  isProsePreempting,
  isWorkerLaneBusy,
  tryAcquireProseLane,
  releaseProseLane,
  tryAcquireWorkerLane,
  releaseWorkerLane,
} from './job-lanes.js'
import { tryAcquireHordeSlot, releaseHordeSlot } from '../inference/horde-slots.js'
import { ensureConcurrencyFeedForUser } from './concurrency-feed.js'
import {
  publishProgress,
  publishDone,
  publishError,
  publishJobCreated,
  publishJobClaimed,
  publishJobStarted,
} from './job-events.js'
import {
  streamingModels,
  runningControllers,
  beginCancellableWorkerJob,
  endCancellableWorkerJob,
  handleStreamingCancel,
} from './cancel.js'
import { streamWithFallback } from './provider-dispatch.js'
import { createLogger } from '../inference/outbound-telemetry.js'
import {
  completeChat,
  withModelFallback,
  JobCancelledError,
  REASONING_ASSISTANT_PREFILL,
  isReasoningModel,
  estimateMessageTokens,
  type ChatMessage,
} from '../inference/featherless.js'
import { submitTextGeneration, pollTextGeneration } from '../inference/horde.js'
import { getDecryptedFeatherlessKey, getDecryptedHordeKey } from '../db/user-store.js'
import type { AgentProfile } from '../config.js'
import { isOpeningPostPage, resolveIcStartPageId } from '../services/story-transition.js'
import {
  buildProseHistory,
  buildSetupConversation,
  buildIcContextBlock,
} from '../services/history.js'
import { applyExtractedWorldbookBlocks } from '../services/worldbook/extraction.js'
import {
  compactStoryWorldbook,
  takeWorldbookCompactJobOpts,
  buildWorldbookCompactResultSummary,
} from '../services/worldbook/compact.js'
import {
  enqueueEligibleStoryToDateJob,
  enqueueStoryToDateNameJob,
  enqueueEligibleFoldJob,
} from '../services/story-to-date/index.js'
import { executeStoryToDateJob } from '../services/story-to-date/worker.js'
import { executeStoryToDateFoldJob } from '../services/story-to-date/fold-worker.js'
import { fillStoryToDateSegmentName, getStoryToDateSegment } from '../db/story-to-date-store.js'
import { nowIso } from '../lib/time.js'
import { getAgentProfile } from '../services/agent-config.js'
import type { GenerationOptions } from '../services/settings-space-registry.js'
import {
  EDITOR_SETUP_PROMPT,
  EDITOR_SETUP_WORLDBOOK,
  EDITOR_UPDATE_PROMPT,
  NAMING_PROMPT,
  ARCHIVE_NAMING_PROMPT,
  guidedRegenerateNote,
  guidedContinueNote,
} from '../prompts.js'

const SCAN_INTERVAL_MS = 500
const WORKER_JOB_TYPES: JobType[] = [
  'story-to-date',
  'story-to-date-fold',
  'story-name',
  'segment-name',
  'worldbook-compact',
]
const PROSE_JOB_TYPES: JobType[] = ['prose', 'setup', 'setup-worldbook']

/**
 * Guided retry's direction text is explicitly not stored as a post
 * (loremaster.md: "The guidance itself is not stored as a post") — it's
 * job-scoped and ephemeral, threaded through in memory rather than the DB,
 * the same way job-events.ts already handles other non-persisted job state.
 */
type GuidanceIntent = 'regenerate' | 'continue'
const jobGuidance = new Map<string, { text: string; intent: GuidanceIntent }>()
export function setJobGuidance(jobId: string, guidance: string, intent: GuidanceIntent): void {
  jobGuidance.set(jobId, { text: guidance, intent })
}

const jobGenerationOptions = new Map<string, GenerationOptions>()
export function setJobGenerationOptions(jobId: string, options: GenerationOptions): void {
  jobGenerationOptions.set(jobId, options)
}

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
  // Length / mood / param / model toggles disabled — Author uses agent-config defaults only.
  return {
    profile,
    chatTemplateKwargs: Object.keys(chatTemplateKwargs).length ? chatTemplateKwargs : undefined,
  }
}

function withinWordLimit(text: string, maxWords: number): boolean {
  return !!text && text.split(/\s+/).length <= maxWords
}

// Counts BOTH forward story-to-date and fold jobs — each is a full-cost Editor call, and the
// account concurrency limit only permits one at a time, so they share the single-in-flight cap.
function countRunningStoryToDateJobsForUser(
  globalDb: ReturnType<typeof getGlobalDb>,
  userId: string,
): number {
  let count = 0
  for (const [storyId, db] of trackedDbs) {
    const story = getStory(globalDb, storyId)
    if (!story || story.ownerUserId !== userId) continue
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM jobs WHERE job_type IN ('story-to-date', 'story-to-date-fold') AND status = 'running'`,
      )
      .get() as { n: number }
    count += row.n
  }
  return count
}

const STORY_NAME_MAX_ATTEMPTS = 2
const NAMING_MAX_TOKENS = 64
const ARCHIVE_NAME_MAX_ATTEMPTS = 3
const STORY_NAME_MAX_WORDS = 12 // generous ceiling for a 2-6 word title — catches "wrote a sentence instead" cases
const NAME_PATTERN = /\[NAME\]([\s\S]*?)\[\/NAME\]/i
const NAME_OPEN_PATTERN = /\[NAME\]\s*([^\n[]+)/i
function isValidExtractedName(content: string): boolean {
  if (/<\|[^|>]*\|>/.test(content)) return false
  if (/:\s+\S/.test(content)) return false
  return withinWordLimit(content, STORY_NAME_MAX_WORDS)
}

function extractStoryName(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  let content: string | null = null
  const closed = NAME_PATTERN.exec(trimmed)
  if (closed?.[1]) {
    content = closed[1].trim()
  } else {
    const open = NAME_OPEN_PATTERN.exec(trimmed)
    if (open?.[1]) content = open[1].trim()
  }

  if (!content) {
    const firstLine =
      trimmed
        .split(/\n/)
        .map((l) => l.trim())
        .find(Boolean) ?? ''
    const cleaned = firstLine
      .replace(/^(?:title|name|scene)\s*:\s*/i, '')
      .replace(/^\[NAME\]\s*/i, '')
      .replace(/^\*+|\*+$/g, '')
      .replace(/^["'`""'']+|["'`""'']+$/g, '')
      .trim()
    if (cleaned && !/[[\]]/.test(cleaned) && isValidExtractedName(cleaned)) {
      content = cleaned
    }
  }

  if (!content) return null
  content = content.replace(/^["'`""'']+|["'`""'']+$/g, '').trim()
  if (!isValidExtractedName(content)) return null
  return content
}

// Deliberately not gated by src/middleware/session-guard.ts — this loop isn't an HTTP
// request, and per the single-active-session design a job a since-superseded session
// started still runs to completion; claiming only changes who's allowed to submit *new*
// interactions, not what happens to work already in flight.
let timer: NodeJS.Timeout | null = null
const trackedDbs = new Map<string, Database.Database>()

/** The pipeline runner only scans stories the API has actually touched this process lifetime — fine for a handful of users, one active story each. */
export function trackStoryDb(storyId: string, db: Database.Database): void {
  trackedDbs.set(storyId, db)
}

/** Must be called whenever a story's underlying DB handle is closed (e.g. story deletion) — otherwise the next scan tick hits a closed better-sqlite3 connection and throws inside a bare setInterval callback, which is fatal to the whole process (see stub-revisions.md, 2026-07-02). */
export function untrackStoryDb(storyId: string): void {
  trackedDbs.delete(storyId)
}

export function startPipelineRunner(): void {
  if (timer) return
  timer = setInterval(scanOnce, SCAN_INTERVAL_MS)
}

export function stopPipelineRunner(): void {
  if (timer) clearInterval(timer)
  timer = null
}

function scanOnce(): void {
  refreshWorkerLaneLimits()
  const globalDb = getGlobalDb()
  for (const [storyId, db] of trackedDbs) {
    try {
      const story = getStory(globalDb, storyId)
      if (!story) {
        trackedDbs.delete(storyId)
        continue
      }
      scanHordeJobs(db, storyId, story.ownerUserId)
    } catch (err) {
      if (!db.open) trackedDbs.delete(storyId)
      createLogger({ storyId, jobType: 'scan-horde' }).error('pipeline horde scan failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  for (const [, db] of trackedDbs) {
    cancelPendingTagGenJobs(db)
  }

  dispatchWorkerJobs(globalDb)

  for (const [storyId, db] of trackedDbs) {
    try {
      const story = getStory(globalDb, storyId)
      if (!story) {
        trackedDbs.delete(storyId)
        continue
      }
      dispatchProseJob(db, story.ownerUserId, storyId)
    } catch (err) {
      createLogger({ storyId, jobType: 'scan-prose' }).error('pipeline prose scan failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

function unclaimJob(db: Database.Database, jobId: string): void {
  db.prepare(`UPDATE jobs SET status = 'pending', started_at = NULL WHERE id = ?`).run(jobId)
}

function cancelPendingTagGenJobs(db: Database.Database): void {
  db.prepare(
    `UPDATE jobs SET status = 'cancelled', finished_at = ?, error = ?
     WHERE job_type = 'tag-gen' AND status IN ('pending', 'running')`,
  ).run(nowIso(), 'tag generation removed')
}

/** Lorepebble-style parallel worker dispatch — up to WORKER_THREADS compress/archive jobs at once. */
function dispatchWorkerJobs(globalDb: ReturnType<typeof getGlobalDb>): void {
  if (isProsePreempting()) return

  while (true) {
    if (!tryAcquireWorkerLane()) break

    let dispatched = false
    for (const [storyId, db] of trackedDbs) {
      const story = getStory(globalDb, storyId)
      if (!story) continue

      const job = claimNextJob(db, WORKER_JOB_TYPES)
      if (!job) continue
      publishJobClaimed(job.id)

      // Editor archives (forward compression and folding alike) cost the full account limit — only one in flight per user.
      if (
        (job.jobType === 'story-to-date' || job.jobType === 'story-to-date-fold') &&
        countRunningStoryToDateJobsForUser(globalDb, story.ownerUserId) > 1
      ) {
        unclaimJob(db, job.id)
        continue
      }

      ensureConcurrencyFeedForUser(
        story.ownerUserId,
        getDecryptedFeatherlessKey(globalDb, story.ownerUserId) ?? '',
      )
      if (!tryAcquireSlot(story.ownerUserId, job.id, job.slotCost)) {
        unclaimJob(db, job.id)
        continue
      }

      dispatched = true
      if (job.jobType === 'story-to-date' && job.targetStoryToDateId) {
        const logbook = getBookByType(db, 'logbook')
        if (!logbook) {
          finishJob(db, job.id, 'failed', 'logbook not found')
          releaseSlot(story.ownerUserId, job.id)
          releaseWorkerLane()
          continue
        }
        publishJobStarted(job.id)
        void executeStoryToDateJobWrapper(
          db,
          story.ownerUserId,
          storyId,
          logbook.id,
          job.id,
          job.targetStoryToDateId,
        )
      } else if (job.jobType === 'story-to-date-fold' && job.targetStoryToDateId) {
        const logbook = getBookByType(db, 'logbook')
        if (!logbook) {
          finishJob(db, job.id, 'failed', 'logbook not found')
          releaseSlot(story.ownerUserId, job.id)
          releaseWorkerLane()
          continue
        }
        publishJobStarted(job.id)
        void executeStoryToDateFoldJobWrapper(
          db,
          story.ownerUserId,
          logbook.id,
          job.id,
          job.targetStoryToDateId,
        )
      } else if (job.jobType === 'story-name' && job.targetTextId) {
        publishJobStarted(job.id)
        void executeStoryNameJob(db, story.ownerUserId, job.id, job.targetTextId, storyId)
      } else if (job.jobType === 'segment-name' && job.targetStoryToDateId) {
        publishJobStarted(job.id)
        void executeStoryToDateNameJob(db, story.ownerUserId, job.id, job.targetStoryToDateId)
      } else if (job.jobType === 'worldbook-compact' && job.targetTextId) {
        publishJobStarted(job.id)
        void executeWorldbookCompactJob(db, story.ownerUserId, job.id)
      } else {
        finishJob(db, job.id, 'failed', `job ${job.id} (${job.jobType}) has no valid target`)
        releaseSlot(story.ownerUserId, job.id)
        releaseWorkerLane()
      }
      break
    }

    if (!dispatched) {
      releaseWorkerLane()
      break
    }
  }
}

function dispatchProseJob(db: Database.Database, userId: string, storyId: string): void {
  if (isWorkerLaneBusy()) return

  const job = claimNextJob(db, PROSE_JOB_TYPES)
  if (!job) return
  publishJobClaimed(job.id)

  // Horde prose: submit-then-poll — does not hold the prose lane (workers may run while queued).
  if (
    job.jobType === 'prose' &&
    job.targetTextId &&
    getAgentProfile(userId, 'author').provider === 'horde'
  ) {
    if (!tryAcquireHordeSlot(job.id)) {
      unclaimJob(db, job.id)
      return
    }
    void executeHordeProseSubmit(db, userId, job.id, job.targetTextId)
    return
  }

  if (!tryAcquireProseLane()) {
    unclaimJob(db, job.id)
    return
  }

  ensureConcurrencyFeedForUser(userId, getDecryptedFeatherlessKey(getGlobalDb(), userId) ?? '')
  if (!tryAcquireSlot(userId, job.id, job.slotCost)) {
    unclaimJob(db, job.id)
    releaseProseLane()
    return
  }

  if (job.jobType === 'prose' && job.targetTextId) {
    const controller = new AbortController()
    runningControllers.set(job.id, controller)
    publishJobStarted(job.id)
    void executeProseJob(db, userId, job.id, job.targetTextId, controller.signal, storyId)
  } else if (job.jobType === 'setup' && job.targetTextId) {
    const controller = new AbortController()
    runningControllers.set(job.id, controller)
    publishJobStarted(job.id)
    void executeSetupJob(db, userId, job.id, job.targetTextId, controller.signal, storyId)
  } else if (job.jobType === 'setup-worldbook' && job.targetTextId) {
    const controller = new AbortController()
    runningControllers.set(job.id, controller)
    publishJobStarted(job.id)
    void executeSetupWorldbookJob(db, userId, job.id, job.targetTextId, controller.signal, storyId)
  } else {
    finishJob(db, job.id, 'failed', `job ${job.id} (${job.jobType}) has no valid target`)
    releaseSlot(userId, job.id)
    releaseProseLane()
  }
}

async function executeProseJob(
  db: Database.Database,
  userId: string,
  jobId: string,
  targetTextId: string,
  signal: AbortSignal,
  storyId: string,
): Promise<void> {
  const startedAt = Date.now()
  let genOptions: GenerationOptions | undefined
  let targetPage: PageRow | undefined
  try {
    const guidance = jobGuidance.get(jobId)
    if (guidance) jobGuidance.delete(jobId)
    const built = buildProseHistory(db, userId, targetTextId, guidance)
    targetPage = built.targetPage
    const { history } = built
    genOptions = jobGenerationOptions.get(jobId)
    jobGenerationOptions.delete(jobId)
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
    releaseProseLane()
  }
}

/**
 * P5a: submit-then-return only, no completion handling here — Horde has no synchronous
 * completion endpoint, so unlike executeProseJob this doesn't await a reply. The job stays
 * 'running' with a horde_request_id recorded once the submit call resolves; scanHordeJobs
 * (P5b) owns polling it to done/faulted on later scan ticks and doing the actual
 * fillTextGeneration/finishJob/publishDone tail. releaseHordeSlot happens there too, not
 * here — the slot represents "still awaiting a result," which is true well past this
 * function's return.
 */
async function executeHordeProseSubmit(
  db: Database.Database,
  userId: string,
  jobId: string,
  targetTextId: string,
): Promise<void> {
  try {
    const guidance = jobGuidance.get(jobId)
    if (guidance) jobGuidance.delete(jobId)
    const { history } = buildProseHistory(db, userId, targetTextId, guidance)
    const profile = getAgentProfile(userId, 'author')
    const hordeKey = getDecryptedHordeKey(getGlobalDb(), userId)
    const { id: requestId } = await submitTextGeneration(profile, hordeKey, history)
    setHordeRequestId(db, jobId, requestId)
    setJobModel(db, jobId, profile.model)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    finishJob(db, jobId, 'failed', message)
    publishError(jobId, message)
    releaseHordeSlot(jobId)
  }
}

// How long a request is allowed to sit with is_possible: false (a live, continuously
// recomputed "no worker currently matches this request" signal, not a one-time rejection —
// see docs/roadmap.md's Horde research notes) before it's treated as a real failure rather
// than a transient dip in pool availability.
const HORDE_IMPOSSIBLE_TIMEOUT_MS = 5 * 60_000
const hordeImpossibleSince = new Map<string, number>()

function hordeJobTerminal(jobId: string): void {
  hordeImpossibleSince.delete(jobId)
  releaseHordeSlot(jobId)
}

/**
 * The "come back later and check on this" half of Horde support — claimNextJob only ever
 * looks at 'pending' rows, so a submitted-but-unresolved Horde job needs its own query
 * (listRunningHordeJobs) to be found again on a later tick. Runs every scan tick alongside
 * scanStory; each job's own poll is fire-and-forget so one slow/stuck poll can't block
 * checking on the others.
 */
function scanHordeJobs(db: Database.Database, storyId: string, userId: string): void {
  for (const job of listRunningHordeJobs(db)) {
    void resolveHordeJob(db, job, storyId, userId)
  }
}

async function resolveHordeJob(
  db: Database.Database,
  job: JobRow,
  storyId: string,
  userId: string,
): Promise<void> {
  if (!job.hordeRequestId || !job.targetTextId) return
  const targetTextId = job.targetTextId

  let status
  try {
    status = await pollTextGeneration(
      job.hordeRequestId,
      getDecryptedHordeKey(getGlobalDb(), userId),
    )
  } catch (err) {
    // Transient poll failure (network hiccup, rate limit) — leave the job running and try
    // again next tick rather than failing it over what might be a momentary blip.
    createLogger({ jobId: job.id, jobType: 'horde-poll' }).error('horde poll failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }

  if (status.faulted) {
    hordeJobTerminal(job.id)
    finishJob(db, job.id, 'failed', 'Horde generation faulted')
    publishError(job.id, 'Horde generation faulted')
    return
  }

  if (status.done) {
    const fullText = status.text ?? ''
    const targetText = getText(db, targetTextId)
    const targetPage = targetText ? getPage(db, targetText.pageId) : null
    const tokenEstimate = Math.ceil(fullText.length / 4)

    fillTextGeneration(db, targetTextId, {
      genPackage: fullText,
      genMetrics: JSON.stringify({ tokenEstimate }),
    })
    if (targetPage) {
      maybeQueueStoryNameJob(db, userId, storyId, targetPage, targetTextId)
      const logbook = getBookByType(db, 'logbook')
      if (logbook) maybeEnqueueStoryToDateJob(db, userId, storyId, logbook.id)
    }

    hordeJobTerminal(job.id)
    // job.model was recorded at submit time (see executeHordeProseSubmit) — reading it back
    // here, rather than re-querying getAgentProfile("author"), is what keeps attribution
    // correct if the user reordered/edited Agents configs while this job was in flight.
    finishJob(db, job.id, 'done', undefined, { model: job.model ?? undefined, tokenEstimate })
    publishDone(job.id, fullText)
    return
  }

  if (!status.isPossible) {
    const firstSeen = hordeImpossibleSince.get(job.id) ?? Date.now()
    hordeImpossibleSince.set(job.id, firstSeen)
    if (Date.now() - firstSeen > HORDE_IMPOSSIBLE_TIMEOUT_MS) {
      hordeJobTerminal(job.id)
      finishJob(db, job.id, 'failed', 'no worker currently available for this model')
      publishError(job.id, 'no worker currently available for this model')
      return
    }
    publishProgress(job.id, 'No worker currently available for this model…')
    return
  }

  hordeImpossibleSince.delete(job.id)
  publishProgress(
    job.id,
    `Queued on AI Horde — position ${status.queuePosition}, ~${status.waitTime}s`,
  )
}

/**
 * The Editor's setup/update turn. Pre-kickoff, this is dual-pass: the conversational reply
 * (EDITOR_SETUP_PROMPT) lands here, then a second, separate worldbook-authoring pass
 * (EDITOR_SETUP_WORLDBOOK) is queued as its own job/page — matching those being two distinct
 * prompts in prompts.md. Post-kickoff "update session" turns are single-pass: EDITOR_UPDATE_PROMPT
 * already embeds the bracket schema inline, so the one reply is scanned for blocks directly,
 * no second page/job. If worldbook extraction fails, the conversational reply the user already
 * sees still stands — a background hiccup shouldn't erase what's already on screen.
 */
async function executeSetupJob(
  db: Database.Database,
  userId: string,
  jobId: string,
  targetTextId: string,
  signal: AbortSignal,
  storyId: string,
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

    const guidance = jobGuidance.get(jobId)
    if (guidance) {
      jobGuidance.delete(jobId)
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

/**
 * The pre-kickoff dual-pass's second half: a separate Editor generation using
 * EDITOR_SETUP_WORLDBOOK, whose raw bracket-tagged output IS the visible log message (the
 * player sees it and it gets highlighted client-side) — not a hidden side-channel the way the
 * old tool-calling extraction pass was. Regex-extracts blocks from its own output immediately
 * after landing; zero blocks found is a normal outcome, not an error.
 */
async function executeSetupWorldbookJob(
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
    releaseProseLane()
  }
}

/**
 * Fires once, right when the kickoff post's generation lands (OOC -> IC) -- checked by page
 * identity against story_state.kickoffPageId, the same check buildProseHistory itself uses, so
 * a later Retry/Guided Retry of that same post re-triggers this too (harmless: the story.name
 * check right after this is what actually gates it to "only while still unnamed"). Called from
 * both prose-completion paths (executeProseJob's Featherless/streamed success and
 * resolveHordeJob's Horde-poll success), since kickoff can run through either provider.
 */
function maybeQueueStoryNameJob(
  db: Database.Database,
  userId: string,
  storyId: string,
  targetPage: PageRow,
  targetTextId: string,
): void {
  if (!isOpeningPostPage(db, targetPage.bookId, targetPage.id)) return

  const story = getStory(getGlobalDb(), storyId)
  if (!story || story.name !== DEFAULT_STORY_NAME) return
  const job = createJob(db, {
    targetTextId,
    jobType: 'story-name',
    slotCost: getAgentProfile(userId, 'worker').concurrencyCost,
    priority: -1,
  })
  publishJobCreated(job.id, job.jobType, storyId)
}

/**
 * Quietly renames a story off its "Working Title" placeholder once it's gone live — see
 * maybeQueueStoryNameJob for the trigger. Re-checks story.name against DEFAULT_STORY_NAME again
 * here (not just at queue time) since this runs some time later and the user could have renamed
 * it by hand in the meantime; that manual rename must win, not get clobbered by a job queued
 * before it happened. Same [NAME]-wrapped, Worker-tier shape; see NAMING_PROMPT's doc comment.
 */
async function executeStoryNameJob(
  db: Database.Database,
  userId: string,
  jobId: string,
  targetTextId: string,
  storyId: string,
): Promise<void> {
  const startedAt = Date.now()
  try {
    const targetText = getText(db, targetTextId)
    if (!targetText?.genPackage) throw new Error('nothing to name from')

    const nameMessages: ChatMessage[] = [
      { role: 'system', content: NAMING_PROMPT },
      { role: 'user', content: targetText.genPackage },
    ]

    let name: string | null = null
    let usedModel = ''
    let lastError = 'unknown error'
    const featherlessKey = getDecryptedFeatherlessKey(getGlobalDb(), userId) ?? ''
    for (let attempt = 1; attempt <= STORY_NAME_MAX_ATTEMPTS && !name; attempt++) {
      try {
        const rawText = await withModelFallback(getAgentProfile(userId, 'worker'), (profile) => {
          usedModel = profile.model
          return completeChat(profile, featherlessKey, nameMessages, {
            maxTokens: NAMING_MAX_TOKENS,
          })
        })
        const candidate = extractStoryName(rawText)
        if (candidate) name = candidate
        else lastError = `no usable [NAME] block on attempt ${attempt}: "${rawText.slice(0, 80)}"`
      } catch (err) {
        lastError = `attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    if (!name)
      throw new Error(`naming failed after ${STORY_NAME_MAX_ATTEMPTS} attempts — ${lastError}`)

    const globalDb = getGlobalDb()
    const story = getStory(globalDb, storyId)
    if (story && story.name === DEFAULT_STORY_NAME) {
      renameStory(globalDb, storyId, name)
    }

    finishJob(db, jobId, 'done', undefined, { model: usedModel, elapsedMs: Date.now() - startedAt })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    finishJob(db, jobId, 'failed', message)
  } finally {
    releaseSlot(userId, jobId)
    releaseWorkerLane()
  }
}

async function executeWorldbookCompactJob(
  db: Database.Database,
  userId: string,
  jobId: string,
): Promise<void> {
  const startedAt = Date.now()
  const opts = takeWorldbookCompactJobOpts(jobId)
  try {
    const editor = getAgentProfile(userId, 'editor')
    const result = await compactStoryWorldbook(db, userId, opts)
    setJobInputTokenEstimate(db, jobId, result.totalBeforeTokens)
    finishJob(db, jobId, 'done', undefined, {
      model: editor.model,
      tokenEstimate: result.totalAfterTokens,
      elapsedMs: Date.now() - startedAt,
      resultSummary: buildWorldbookCompactResultSummary(result),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    finishJob(db, jobId, 'failed', message)
  } finally {
    releaseSlot(userId, jobId)
    releaseWorkerLane()
  }
}

/** Names a story-to-date segment from its summary — tab display only, not prompt assembly. */
async function executeStoryToDateNameJob(
  db: Database.Database,
  userId: string,
  jobId: string,
  segmentId: string,
): Promise<void> {
  const controller = beginCancellableWorkerJob(jobId)
  const startedAt = Date.now()
  try {
    const segment = getStoryToDateSegment(db, segmentId)
    if (!segment?.content?.trim()) throw new Error('segment has no content to name from')

    const nameMessages: ChatMessage[] = [
      { role: 'system', content: ARCHIVE_NAMING_PROMPT },
      { role: 'user', content: `Scene summary:\n${segment.content.trim()}` },
    ]

    let name: string | null = null
    let usedModel = ''
    let lastError = 'unknown error'
    const featherlessKey = getDecryptedFeatherlessKey(getGlobalDb(), userId) ?? ''
    const workerProfile = getAgentProfile(userId, 'worker')
    for (let attempt = 1; attempt <= ARCHIVE_NAME_MAX_ATTEMPTS && !name; attempt++) {
      try {
        const rawText = await withModelFallback(workerProfile, (profile) => {
          usedModel = profile.model
          return completeChat(profile, featherlessKey, nameMessages, {
            maxTokens: NAMING_MAX_TOKENS,
            signal: controller.signal,
          })
        })
        name = extractStoryName(rawText)
        if (!name?.trim()) {
          lastError = `no usable [NAME] block on attempt ${attempt}: "${rawText.trim().slice(0, 80)}"`
        }
      } catch (err) {
        lastError = `attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    if (!name)
      throw new Error(
        `segment naming failed after ${ARCHIVE_NAME_MAX_ATTEMPTS} attempts — ${lastError}`,
      )
    fillStoryToDateSegmentName(db, segmentId, name)
    finishJob(db, jobId, 'done', undefined, { model: usedModel, elapsedMs: Date.now() - startedAt })
  } catch (err) {
    if (err instanceof JobCancelledError) {
      cancelJob(db, jobId)
    } else {
      const message = err instanceof Error ? err.message : String(err)
      finishJob(db, jobId, 'failed', message)
    }
  } finally {
    endCancellableWorkerJob(jobId)
    releaseSlot(userId, jobId)
    releaseWorkerLane()
  }
}

async function executeStoryToDateJobWrapper(
  db: Database.Database,
  userId: string,
  storyId: string,
  logbookId: string,
  jobId: string,
  segmentId: string,
): Promise<void> {
  const controller = beginCancellableWorkerJob(jobId)
  const startedAt = Date.now()
  try {
    const apiKey = getDecryptedFeatherlessKey(getGlobalDb(), userId) ?? ''
    if (!apiKey) throw new Error('no Featherless API key configured')
    await executeStoryToDateJob(
      db,
      userId,
      storyId,
      logbookId,
      segmentId,
      apiKey,
      controller.signal,
    )
    const editor = getAgentProfile(userId, 'editor')
    finishJob(db, jobId, 'done', undefined, {
      model: editor.model,
      elapsedMs: Date.now() - startedAt,
    })
    enqueueStoryToDateNameJob(db, userId, segmentId)
    enqueueEligibleStoryToDateJob(db, userId, logbookId, storyId)
    // Feature A: once forward compression settles, check whether accumulated memory now warrants
    // folding the deep past. Runs after (not instead of) forward work — the one-Editor guard keeps
    // them from contending for the single account slot.
    enqueueEligibleFoldJob(db, userId, logbookId)
  } catch (err) {
    if (err instanceof JobCancelledError) {
      cancelJob(db, jobId)
    } else {
      const message = err instanceof Error ? err.message : String(err)
      finishJob(db, jobId, 'failed', message)
    }
  } finally {
    endCancellableWorkerJob(jobId)
    releaseSlot(userId, jobId)
    releaseWorkerLane()
  }
}

async function executeStoryToDateFoldJobWrapper(
  db: Database.Database,
  userId: string,
  logbookId: string,
  jobId: string,
  targetSegmentId: string,
): Promise<void> {
  const controller = beginCancellableWorkerJob(jobId)
  const startedAt = Date.now()
  try {
    const apiKey = getDecryptedFeatherlessKey(getGlobalDb(), userId) ?? ''
    if (!apiKey) throw new Error('no Featherless API key configured')
    await executeStoryToDateFoldJob(
      db,
      userId,
      logbookId,
      targetSegmentId,
      apiKey,
      controller.signal,
    )
    const editor = getAgentProfile(userId, 'editor')
    finishJob(db, jobId, 'done', undefined, {
      model: editor.model,
      elapsedMs: Date.now() - startedAt,
    })
  } catch (err) {
    if (err instanceof JobCancelledError) {
      cancelJob(db, jobId)
    } else {
      const message = err instanceof Error ? err.message : String(err)
      finishJob(db, jobId, 'failed', message)
    }
  } finally {
    endCancellableWorkerJob(jobId)
    releaseSlot(userId, jobId)
    releaseWorkerLane()
  }
}

function maybeEnqueueStoryToDateJob(
  db: Database.Database,
  userId: string,
  storyId: string,
  logbookId: string,
): void {
  enqueueEligibleStoryToDateJob(db, userId, logbookId, storyId)
}
