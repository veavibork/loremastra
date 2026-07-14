import { copyFileSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { getStoryDb, storyDbPath } from '../db/story-db.js'
import { createStory, type StoryRow } from '../db/story-store.js'
import { getBookByType } from '../db/book-store.js'
import { findHeadPageId, getPage, setSelectedFork, setPageHidden } from '../db/page-store.js'
import { setCurrentPageId } from '../db/story-state-store.js'
import { pruneStoryToDateOffActiveChain } from '../services/context/invalidation.js'

/**
 * "Fork" per the schema-design decision: a genuinely new save slot, a full
 * physical copy of the story's SQLite file — not an in-place branch pointer
 * (that's Rewind/Undo/Redo, which share one ephemeral cursor within a single
 * story). The worldbook is copied at its current (latest) state rather than
 * reconstructed as of the fork point's timestamp — worldbook entries aren't
 * chronologically linked to log pages the way posts are, so true point-in-
 * time worldbook reconstruction would need to diff every entry's version
 * history against timestamps. Deferred as a Future-Phases-caliber feature
 * (adjacent to the doc's own "worldbook deltas" idea); most forks happen
 * close to the story's current state anyway, so the drift is usually small.
 */
export function forkStory(
  globalDb: Database.Database,
  sourceDb: Database.Database,
  input: {
    ownerUserId: string
    sourceStoryId: string
    sourceName: string
    name?: string
    forkPageId?: string | null
  },
): StoryRow {
  const logbook = getBookByType(sourceDb, 'logbook')
  if (!logbook) throw new Error('logbook not found')

  const headPageId = findHeadPageId(sourceDb, logbook.id)
  if (!headPageId) throw new Error('story has no posts yet')
  const forkPageId = input.forkPageId ?? headPageId
  if (!getPage(sourceDb, forkPageId)) throw new Error('fork point page not found')

  // Flush WAL into the main file so the copy below captures everything committed so far.
  sourceDb.pragma('wal_checkpoint(TRUNCATE)')

  const newStory = createStory(globalDb, {
    ownerUserId: input.ownerUserId,
    name: input.name?.trim() || defaultForkName(input.sourceName),
    parentStoryId: input.sourceStoryId,
  })
  copyFileSync(storyDbPath(input.sourceStoryId), storyDbPath(newStory.id))

  const newDb = getStoryDb(newStory.id)

  // Hide everything after the fork point, then sever its forward pointer — the branch is
  // independent from here on, structurally as well as visually. A separate story file has
  // no "redo forward" concept to preserve, unlike the live ephemeral cursor used for Undo/
  // Redo within a single story, so this is a permanent severing, not just a cursor move.
  let cursor = getPage(newDb, forkPageId)?.selectedForkPageId ?? null
  while (cursor) {
    setPageHidden(newDb, cursor, true)
    cursor = getPage(newDb, cursor)?.selectedForkPageId ?? null
  }
  setSelectedFork(newDb, forkPageId, null)
  setCurrentPageId(newDb, null)
  pruneStoryToDateOffActiveChain(newDb, input.ownerUserId, logbook.id, newStory.id)

  return newStory
}

function defaultForkName(sourceName: string): string {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  return `${sourceName} — Fork — ${stamp}`
}
