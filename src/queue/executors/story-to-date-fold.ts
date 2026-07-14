/** Fold wrapper: compresses old story-to-date segments into a deeper summary. */
import type Database from 'better-sqlite3'
import { finishJob, cancelJob } from '../../db/job-store.js'
import { getGlobalDb } from '../../db/global-db.js'
import { getDecryptedFeatherlessKey } from '../../db/user-store.js'
import { getAgentProfile } from '../../services/agent-config.js'
import { executeStoryToDateFoldJob } from '../../services/story-to-date/fold-worker.js'
import { JobCancelledError } from '../../inference/featherless.js'
import { releaseSlot } from '../slots.js'
import { beginCancellableWorkerJob, endCancellableWorkerJob } from '../cancel.js'

export async function executeStoryToDateFoldJobWrapper(
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
  }
}
