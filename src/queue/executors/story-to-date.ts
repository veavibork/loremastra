/** Forward-compression wrapper: summarizes recent IC posts into a story-to-date segment. */
import type Database from 'better-sqlite3'
import { finishJob, cancelJob } from '../../db/job-store.js'
import { getGlobalDb } from '../../db/global-db.js'
import { getDecryptedFeatherlessKey } from '../../db/user-store.js'
import { getAgentProfile } from '../../services/agent-config.js'
import { executeStoryToDateJob } from '../../services/story-to-date/worker.js'
import {
  enqueueEligibleStoryToDateJob,
  enqueueStoryToDateNameJob,
  enqueueEligibleFoldJob,
} from '../../services/story-to-date/index.js'
import { JobCancelledError } from '../../inference/featherless.js'
import { releaseSlot } from '../slots.js'
import { releaseWorkerLane } from '../job-lanes.js'
import { beginCancellableWorkerJob, endCancellableWorkerJob } from '../cancel.js'

export async function executeStoryToDateJobWrapper(
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
