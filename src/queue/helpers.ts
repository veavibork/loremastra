/**
 * Shared pipeline helpers — post-generation side effects called from multiple executors
 * and the Horde poll loop. Extracted from dispatch.ts to avoid circular imports
 * between executors and the main dispatch module.
 */
import type Database from 'better-sqlite3'
import { createJob } from '../db/job-store.js'
import { getStory } from '../db/story-store.js'
import { getGlobalDb } from '../db/global-db.js'
import { getAgentProfile } from '../services/agent-config.js'
import { isOpeningPostPage } from '../services/story-transition.js'
import { enqueueEligibleStoryToDateJob } from '../services/story-to-date/index.js'
import { publishStoryDataChanged } from './story-events.js'
import { DEFAULT_STORY_NAME } from '../db/story-store.js'
import type { PageRow } from '../db/page-store.js'

/**
 * Fires once, right when the kickoff post's generation lands (OOC -> IC) — checked by page
 * identity against story_state.kickoffPageId, the same check buildProseHistory itself uses, so
 * a later Retry/Guided Retry of that same post re-triggers this too (harmless: the story.name
 * check right after this is what actually gates it to "only while still unnamed"). Called from
 * both prose-completion paths (executeProseJob's Featherless/streamed success and
 * resolveHordeJob's Horde-poll success), since kickoff can run through either provider.
 */
export function maybeQueueStoryNameJob(
  db: Database.Database,
  userId: string,
  storyId: string,
  targetPage: PageRow,
  targetTextId: string,
): void {
  if (!isOpeningPostPage(db, targetPage.bookId, targetPage.id)) return

  const story = getStory(getGlobalDb(), storyId)
  if (!story || story.name !== DEFAULT_STORY_NAME) return
  createJob(db, {
    targetTextId,
    jobType: 'story-name',
    slotCost: getAgentProfile(userId, 'worker').concurrencyCost,
    priority: -1,
  })
  publishStoryDataChanged(storyId, 'jobs')
}

export function maybeEnqueueStoryToDateJob(
  db: Database.Database,
  userId: string,
  storyId: string,
  logbookId: string,
): void {
  enqueueEligibleStoryToDateJob(db, userId, logbookId, storyId)
}

/** Counts BOTH forward story-to-date and fold jobs — each is a full-cost Editor call, and the
 * account concurrency limit only permits one at a time, so they share the single-in-flight cap.
 */
export function countRunningStoryToDateJobsForUser(
  globalDb: ReturnType<typeof getGlobalDb>,
  userId: string,
  trackedDbs: Map<string, Database.Database>,
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
