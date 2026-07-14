/**
 * Quietly renames a story off its "Working Title" placeholder once it's gone live — see
 * maybeQueueStoryNameJob for the trigger. Re-checks story.name against DEFAULT_STORY_NAME again
 * here (not just at queue time) since this runs some time later and the user could have renamed
 * it by hand in the meantime; that manual rename must win, not get clobbered by a job queued
 * before it happened. Same [NAME]-wrapped, Worker-tier shape; see NAMING_PROMPT's doc comment.
 */
import type Database from 'better-sqlite3'
import { finishJob } from '../../db/job-store.js'
import { getText } from '../../db/text-store.js'
import { getStory, renameStory, DEFAULT_STORY_NAME } from '../../db/story-store.js'
import { getGlobalDb } from '../../db/global-db.js'
import { getDecryptedFeatherlessKey } from '../../db/user-store.js'
import { getAgentProfile } from '../../services/agent-config.js'
import { NAMING_PROMPT } from '../../prompts.js'
import { completeChat, withModelFallback, type ChatMessage } from '../../inference/featherless.js'
import { releaseSlot } from '../slots.js'
import { extractStoryName, NAMING_MAX_TOKENS, STORY_NAME_MAX_ATTEMPTS } from './naming.js'

export async function executeStoryNameJob(
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
  }
}
