/** Compacts a story's worldbook entries to reduce token count for future generations. */
import type Database from 'better-sqlite3'
import { finishJob, setJobInputTokenEstimate } from '../../db/job-store.js'
import { getAgentProfile } from '../../services/agent-config.js'
import {
  compactStoryWorldbook,
  takeWorldbookCompactJobOpts,
  buildWorldbookCompactResultSummary,
} from '../../services/worldbook/compact.js'
import { releaseSlot } from '../slots.js'
import { releaseWorkerLane } from '../job-lanes.js'

export async function executeWorldbookCompactJob(
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
