import type Database from 'better-sqlite3'
import {
  claimNextJob,
  finishJob,
  setHordeRequestId,
  setJobModel,
  listRunningHordeJobs,
  hasActiveJobByType,
  type JobRow,
  type JobType,
} from '../db/job-store.js'
import { fillTextGeneration, getText } from '../db/text-store.js'
import { getPage } from '../db/page-store.js'
import { getBookByType } from '../db/book-store.js'
import { getGlobalDb } from '../db/global-db.js'
import { getStory } from '../db/story-store.js'
import { tryAcquireSlot, releaseSlot } from './slots.js'

import { canSubmitHorde, recordHordeSubmit } from '../inference/horde-rate-limiter.js'
import { ensureConcurrencyFeedForUser } from './concurrency-feed.js'
import {
  publishProgress,
  publishDone,
  publishError,
  publishJobClaimed,
  publishJobStarted,
} from './job-events.js'
import { runningControllers } from './cancel.js'
import {
  maybeQueueStoryNameJob,
  maybeEnqueueStoryToDateJob,
  countRunningStoryToDateJobsForUser,
} from './helpers.js'
import { executeStoryToDateNameJob } from './executors/segment-name.js'
import { executeStoryNameJob } from './executors/story-name.js'
import { executeWorldbookCompactJob } from './executors/worldbook-compact.js'
import { executeStoryToDateJobWrapper } from './executors/story-to-date.js'
import { executeStoryToDateFoldJobWrapper } from './executors/story-to-date-fold.js'
import { executeProseJob } from './executors/prose.js'
import { executeSetupJob } from './executors/setup.js'
import { executeSetupWorldbookJob } from './executors/setup-worldbook.js'
import { createLogger } from '../inference/outbound-telemetry.js'
import { submitTextGeneration, pollTextGeneration } from '../inference/horde.js'
import { getDecryptedFeatherlessKey, getDecryptedHordeKey } from '../db/user-store.js'
import { buildProseHistory } from '../services/history.js'
import { nowIso } from '../lib/time.js'
import { getAgentProfile } from '../services/agent-config.js'
import type { GenerationOptions } from '../services/settings-space-registry.js'

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

  // Prose dispatches first — priority ordering means the user's interactive generation
  // claims slots before background workers. Slots.ts is the sole gatekeeper.
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

  dispatchWorkerJobs(globalDb)
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

/** Worker dispatch — slots.ts is the sole gatekeeper. Loop tries to claim and dispatch
 * worker jobs until no more can be acquired. */
function dispatchWorkerJobs(globalDb: ReturnType<typeof getGlobalDb>): void {
  while (true) {
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
        countRunningStoryToDateJobsForUser(globalDb, story.ownerUserId, trackedDbs) > 1
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
      }
      break
    }

    if (!dispatched) break
  }
}

function dispatchProseJob(db: Database.Database, userId: string, storyId: string): void {
  const job = claimNextJob(db, PROSE_JOB_TYPES)
  if (!job) return

  // Context-pressure gate: if a story-to-date (forward compression) job is in-flight,
  // the segment isn't ready yet. Block prose until it completes — the user accepts the
  // 4-5 minute wait since segment construction is the platform's purpose.
  if (job.jobType === 'prose' && hasActiveJobByType(db, 'story-to-date')) {
    unclaimJob(db, job.id)
    return
  }

  publishJobClaimed(job.id)

  // Horde prose: submit-then-poll — does not hold a slot (workers may run while queued).
  if (
    job.jobType === 'prose' &&
    job.targetTextId &&
    getAgentProfile(userId, 'author').provider === 'horde'
  ) {
    if (!canSubmitHorde()) {
      unclaimJob(db, job.id)
      return
    }
    recordHordeSubmit()
    void executeHordeProseSubmit(db, userId, job.id, job.targetTextId)
    return
  }

  ensureConcurrencyFeedForUser(userId, getDecryptedFeatherlessKey(getGlobalDb(), userId) ?? '')
  if (!tryAcquireSlot(userId, job.id, job.slotCost)) {
    unclaimJob(db, job.id)
    return
  }

  if (job.jobType === 'prose' && job.targetTextId) {
    const controller = new AbortController()
    runningControllers.set(job.id, controller)
    publishJobStarted(job.id)
    const guidance = jobGuidance.get(job.id)
    if (guidance) jobGuidance.delete(job.id)
    const genOptions = jobGenerationOptions.get(job.id)
    jobGenerationOptions.delete(job.id)
    void executeProseJob(
      db,
      userId,
      job.id,
      job.targetTextId,
      controller.signal,
      storyId,
      guidance,
      genOptions,
    )
  } else if (job.jobType === 'setup' && job.targetTextId) {
    const controller = new AbortController()
    runningControllers.set(job.id, controller)
    publishJobStarted(job.id)
    const guidance = jobGuidance.get(job.id)
    if (guidance) jobGuidance.delete(job.id)
    void executeSetupJob(db, userId, job.id, job.targetTextId, controller.signal, storyId, guidance)
  } else if (job.jobType === 'setup-worldbook' && job.targetTextId) {
    const controller = new AbortController()
    runningControllers.set(job.id, controller)
    publishJobStarted(job.id)
    void executeSetupWorldbookJob(db, userId, job.id, job.targetTextId, controller.signal, storyId)
  } else {
    finishJob(db, job.id, 'failed', `job ${job.id} (${job.jobType}) has no valid target`)
    releaseSlot(userId, job.id)
  }
}

/**
 * P5a: submit-then-return only, no completion handling here — Horde has no synchronous
 * completion endpoint, so unlike executeProseJob this doesn't await a reply. The job stays
 * 'running' with a horde_request_id recorded once the submit call resolves; scanHordeJobs
 * (P5b) owns polling it to done/faulted on later scan ticks and doing the actual
 * fillTextGeneration/finishJob/publishDone tail. hordeJobTerminal (called on
 * completion/failure) cleans up the impossible-since tracker — there's no slot
 * to release since rate limiting is purely time-based.
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
