import type Database from 'better-sqlite3'
import {
  claimNextJob,
  finishJob,
  setHordeRequestId,
  setJobModel,
  listRunningHordeJobs,
  listActiveJobs,
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
  getJobBuffer,
  publishProgress,
  publishDone,
  publishError,
  publishJobClaimed,
  publishJobStarted,
} from './job-events.js'
import { publishStoryDataChanged, type StoryDataKind } from './story-events.js'
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
import {
  submitTextGeneration,
  pollTextGeneration,
  HordeKudosUpfrontError,
} from '../inference/horde.js'
import { getDecryptedFeatherlessKey, getDecryptedHordeKey } from '../db/user-store.js'
import { buildProseHistory } from '../services/history.js'
import { nowIso } from '../lib/time.js'
import { getAgentProfile } from '../services/agent-config.js'
import type { GenerationOptions } from '../services/settings-space-registry.js'

const SCAN_INTERVAL_MS = 500
/** Shown on a queued prose post while a story-to-date job blocks it (see dispatchProseJob's gate). */
const MEMORY_WAIT_LABEL = 'Waiting for memory update…'
const WORKER_JOB_TYPES: JobType[] = [
  'story-to-date',
  'story-to-date-fold',
  'story-name',
  'segment-name',
  'worldbook-compact',
]
const PROSE_JOB_TYPES: JobType[] = ['prose', 'setup', 'setup-worldbook']

/**
 * Which story-scoped data view a finished job may have written to — drives the SSE
 * data-changed ping that replaced the Worldbook/Segments tabs' fixed-interval polling.
 * Published unconditionally on completion (success or failure): a failed story-to-date
 * still deleted-then-recreated pending segment rows worth refetching, and a spurious
 * refetch is one cheap GET.
 */
const JOB_DATA_KINDS: Partial<Record<JobType, StoryDataKind>> = {
  'story-to-date': 'segments',
  'story-to-date-fold': 'segments',
  'segment-name': 'segments',
  'worldbook-compact': 'worldbook',
  setup: 'worldbook',
  'setup-worldbook': 'worldbook',
}

function publishJobDataChanged(storyId: string, jobType: JobType): void {
  const kind = JOB_DATA_KINDS[jobType]
  if (kind) publishStoryDataChanged(storyId, kind)
}

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

/**
 * Drops a job's ephemeral in-memory state (guidance + generation options). Dispatch clears these
 * as it claims a job, but a job cancelled while still *pending* never gets dispatched — call this
 * on that path so its entries don't leak for the lifetime of the process.
 */
export function clearJobEphemeralState(jobId: string): void {
  jobGuidance.delete(jobId)
  jobGenerationOptions.delete(jobId)
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

/**
 * Aggregate job counts across every tracked story DB, for src/index.ts's pipeline-health
 * snapshot (buildHealthSnapshot). trackedDbs is otherwise process-internal to this module, so
 * this is the minimal exported accessor rather than reaching into it directly from index.ts.
 * Skips any DB whose handle has since closed (e.g. story deletion raced with a snapshot tick).
 */
export function getTrackedJobCounts(): {
  activeJobs: number
  pendingJobs: number
  hordeJobsRunning: number
} {
  let activeJobs = 0
  let pendingJobs = 0
  let hordeJobsRunning = 0
  for (const db of trackedDbs.values()) {
    if (!db.open) continue
    for (const job of listActiveJobs(db)) {
      if (job.status === 'running') activeJobs++
      else pendingJobs++
    }
    hordeJobsRunning += listRunningHordeJobs(db).length
  }
  return { activeJobs, pendingJobs, hordeJobsRunning }
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
      // Ping at dispatch-start too, not just completion — the Segments tab renders the memory
      // job's own status (pending/running), and the pending→running flip happens right here.
      publishJobDataChanged(storyId, job.jobType)
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
        ).finally(() => publishJobDataChanged(storyId, job.jobType))
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
        ).finally(() => publishJobDataChanged(storyId, job.jobType))
      } else if (job.jobType === 'story-name' && job.targetTextId) {
        publishJobStarted(job.id)
        void executeStoryNameJob(db, story.ownerUserId, job.id, job.targetTextId, storyId)
      } else if (job.jobType === 'segment-name' && job.targetStoryToDateId) {
        publishJobStarted(job.id)
        void executeStoryToDateNameJob(
          db,
          story.ownerUserId,
          job.id,
          job.targetStoryToDateId,
        ).finally(() => publishJobDataChanged(storyId, job.jobType))
      } else if (job.jobType === 'worldbook-compact' && job.targetTextId) {
        publishJobStarted(job.id)
        void executeWorldbookCompactJob(db, story.ownerUserId, job.id).finally(() =>
          publishJobDataChanged(storyId, job.jobType),
        )
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
  // 4-5 minute wait since segment construction is the platform's purpose. Tell them WHY
  // via the job's progress channel (this replaced the client-side wait-phase poller the
  // polling-elimination refactor removed); the label clears on the 'prefill' event once
  // the job actually starts. Guarded so the 500ms scan doesn't re-emit an unchanged label.
  if (job.jobType === 'prose' && hasActiveJobByType(db, 'story-to-date')) {
    if (getJobBuffer(job.id)?.progress !== MEMORY_WAIT_LABEL) {
      publishProgress(job.id, MEMORY_WAIT_LABEL)
    }
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
    void executeSetupJob(
      db,
      userId,
      job.id,
      job.targetTextId,
      controller.signal,
      storyId,
      guidance,
    ).finally(() => publishJobDataChanged(storyId, job.jobType))
  } else if (job.jobType === 'setup-worldbook' && job.targetTextId) {
    const controller = new AbortController()
    runningControllers.set(job.id, controller)
    publishJobStarted(job.id)
    void executeSetupWorldbookJob(
      db,
      userId,
      job.id,
      job.targetTextId,
      controller.signal,
      storyId,
    ).finally(() => publishJobDataChanged(storyId, job.jobType))
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
    try {
      const { id: requestId } = await submitTextGeneration(profile, hordeKey, history)
      setHordeRequestId(db, jobId, requestId)
      setJobModel(db, jobId, profile.model)
    } catch (err) {
      if (err instanceof HordeKudosUpfrontError) {
        // Retry with capped max_length — the model works, just with shorter output
        const { id: requestId } = await submitTextGeneration(profile, hordeKey, history, {
          maxLengthOverride: 512,
        })
        setHordeRequestId(db, jobId, requestId)
        setJobModel(db, jobId, profile.model)
      } else {
        throw err
      }
    }
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

/** Floor between upstream status polls per Horde job — the 500ms scan tick is dispatch cadence,
 * not a sane rate to hit the AI Horde API with (generations there resolve on a seconds-to-minutes
 * scale, and aggressive polling burns their rate limit for zero freshness). */
const HORDE_POLL_MIN_INTERVAL_MS = 2500
const hordePollInFlight = new Set<string>()
const hordeLastPollAt = new Map<string, number>()

function hordeJobTerminal(jobId: string): void {
  hordeImpossibleSince.delete(jobId)
  hordeLastPollAt.delete(jobId)
}

/**
 * The "come back later and check on this" half of Horde support — claimNextJob only ever
 * looks at 'pending' rows, so a submitted-but-unresolved Horde job needs its own query
 * (listRunningHordeJobs) to be found again on a later tick. Runs every scan tick alongside
 * scanStory; each job's own poll is fire-and-forget so one slow/stuck poll can't block
 * checking on the others. The in-flight set stops successive ticks from stacking overlapping
 * HTTP polls for the same job when one upstream call takes longer than a tick.
 */
function scanHordeJobs(db: Database.Database, storyId: string, userId: string): void {
  const now = Date.now()
  for (const job of listRunningHordeJobs(db)) {
    if (hordePollInFlight.has(job.id)) continue
    if (now - (hordeLastPollAt.get(job.id) ?? 0) < HORDE_POLL_MIN_INTERVAL_MS) continue
    hordePollInFlight.add(job.id)
    hordeLastPollAt.set(job.id, now)
    void resolveHordeJob(db, job, storyId, userId).finally(() => {
      hordePollInFlight.delete(job.id)
    })
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
    const tokenEstimate = Math.ceil(fullText.length / 4)
    try {
      const targetText = getText(db, targetTextId)
      const targetPage = targetText ? getPage(db, targetText.pageId) : null

      fillTextGeneration(db, targetTextId, {
        genPackage: fullText,
        genMetrics: JSON.stringify({ tokenEstimate }),
      })

      // Follow-up bookkeeping (story-name + story-to-date enqueue) is secondary to delivering the
      // reply — isolate it so a throw here can't abort completion below and leave the job stuck
      // 'running' to be re-polled (and re-thrown) every tick forever.
      try {
        if (targetPage) {
          maybeQueueStoryNameJob(db, userId, storyId, targetPage, targetTextId)
          const logbook = getBookByType(db, 'logbook')
          if (logbook) maybeEnqueueStoryToDateJob(db, userId, storyId, logbook.id)
        }
      } catch (err) {
        createLogger({ jobId: job.id, jobType: 'horde-resolve' }).error(
          'horde post-completion follow-up failed (reply still delivered)',
          { error: err instanceof Error ? err.message : String(err) },
        )
      }

      hordeJobTerminal(job.id)
      // job.model was recorded at submit time (see executeHordeProseSubmit) — reading it back
      // here, rather than re-querying getAgentProfile("author"), is what keeps attribution
      // correct if the user reordered/edited Agents configs while this job was in flight.
      finishJob(db, job.id, 'done', undefined, { model: job.model ?? undefined, tokenEstimate })
      publishDone(job.id, fullText)
    } catch (err) {
      // Delivering the reply itself failed (e.g. the fillTextGeneration write). Fail the job
      // terminally so the error surfaces and it stops being re-polled — otherwise it stays
      // 'running' with horde_request_id set and this branch re-runs (and re-fails) every tick,
      // the exact silent-stuck-forever state this guard exists to prevent.
      const message = err instanceof Error ? err.message : String(err)
      createLogger({ jobId: job.id, jobType: 'horde-resolve' }).error(
        'horde job completion failed',
        {
          error: message,
        },
      )
      hordeJobTerminal(job.id)
      finishJob(db, job.id, 'failed', message)
      publishError(job.id, message)
    }
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
