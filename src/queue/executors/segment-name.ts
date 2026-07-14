/** Names a story-to-date segment from its summary — tab display only, not prompt assembly. */
import type Database from 'better-sqlite3'
import { finishJob, cancelJob } from '../../db/job-store.js'
import { getStoryToDateSegment, fillStoryToDateSegmentName } from '../../db/story-to-date-store.js'
import { getGlobalDb } from '../../db/global-db.js'
import { getDecryptedFeatherlessKey } from '../../db/user-store.js'
import { getAgentProfile } from '../../services/agent-config.js'
import { SEGMENT_NAMING_PROMPT } from '../../prompts.js'
import {
  completeChat,
  withModelFallback,
  JobCancelledError,
  type ChatMessage,
} from '../../inference/featherless.js'
import { releaseSlot } from '../slots.js'
import { beginCancellableWorkerJob, endCancellableWorkerJob } from '../cancel.js'
import { extractStoryName, NAMING_MAX_TOKENS, SEGMENT_NAME_MAX_ATTEMPTS } from './naming.js'

export async function executeStoryToDateNameJob(
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
      { role: 'system', content: SEGMENT_NAMING_PROMPT },
      { role: 'user', content: `Scene summary:\n${segment.content.trim()}` },
    ]

    let name: string | null = null
    let usedModel = ''
    let lastError = 'unknown error'
    const featherlessKey = getDecryptedFeatherlessKey(getGlobalDb(), userId) ?? ''
    const workerProfile = getAgentProfile(userId, 'worker')
    for (let attempt = 1; attempt <= SEGMENT_NAME_MAX_ATTEMPTS && !name; attempt++) {
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
        `segment naming failed after ${SEGMENT_NAME_MAX_ATTEMPTS} attempts — ${lastError}`,
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
  }
}
