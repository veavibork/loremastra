/** Coverage-audit wrapper: majority-vote judge over a segment's coverage window — detector only, flags the segment for the Segments tab (see services/story-to-date/audit.ts). */
import type Database from 'better-sqlite3'
import { finishJob, cancelJob } from '../../db/job-store.js'
import { getGlobalDb } from '../../db/global-db.js'
import { getDecryptedFeatherlessKey } from '../../db/user-store.js'
import { getAgentProfile } from '../../services/agent-config.js'
import { executeSegmentAudit, AUDIT_VOTES } from '../../services/story-to-date/audit.js'
import { JobCancelledError } from '../../inference/featherless.js'
import { releaseSlot } from '../slots.js'
import { beginCancellableWorkerJob, endCancellableWorkerJob } from '../cancel.js'
import { publishProgress } from '../job-events.js'

export async function executeSegmentAuditJobWrapper(
  db: Database.Database,
  userId: string,
  storyId: string,
  logbookId: string,
  jobId: string,
  targetSegmentId: string,
): Promise<void> {
  const controller = beginCancellableWorkerJob(jobId)
  const startedAt = Date.now()
  try {
    const apiKey = getDecryptedFeatherlessKey(getGlobalDb(), userId) ?? ''
    if (!apiKey) throw new Error('no Featherless API key configured')
    const editor = getAgentProfile(userId, 'editor')
    const result = await executeSegmentAudit(
      db,
      editor,
      apiKey,
      storyId,
      logbookId,
      targetSegmentId,
      {
        signal: controller.signal,
        onVote: (n) => publishProgress(jobId, `Audit vote ${n} of ${AUDIT_VOTES}…`),
      },
    )
    finishJob(db, jobId, 'done', undefined, {
      model: editor.model,
      elapsedMs: Date.now() - startedAt,
      resultSummary:
        result.verdict === 'flagged'
          ? `flagged (${result.failVotes}/${result.votes.length} fail votes, ${result.missing.length} missing)`
          : `pass (${result.votes.length - result.failVotes}/${result.votes.length} pass votes)`,
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
