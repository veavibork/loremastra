#!/usr/bin/env npx tsx
/** List recent story-to-date job failures for a story. */
import { getGlobalDb } from '../src/db/global-db.js'
import { getStoryDb } from '../src/db/story-db.js'
import { getStory } from '../src/db/story-store.js'
import { getBookByType } from '../src/db/book-store.js'
import { listStoryToDateSegments } from '../src/db/story-to-date-store.js'

const storyId = process.argv[2] ?? '019f25e0-219c-7189-b481-9f389a9a3c39'

const story = getStory(getGlobalDb(), storyId)
const db = getStoryDb(storyId)
const logbook = getBookByType(db, 'logbook')

console.log('story:', story?.name, storyId)

const jobs = db
  .prepare(
    `SELECT id, status, error, created_at, finished_at, target_story_to_date_id
     FROM jobs WHERE job_type = 'story-to-date'
     ORDER BY created_at DESC LIMIT 15`,
  )
  .all() as {
  id: string
  status: string
  error: string | null
  created_at: string
  finished_at: string | null
  target_story_to_date_id: string | null
}[]

console.log(`\nrecent story-to-date jobs (${jobs.length}):`)
for (const j of jobs) {
  console.log(`\n  ${j.status} ${j.created_at}`)
  console.log(`  segment: ${j.target_story_to_date_id ?? '—'}`)
  if (j.error) console.log(`  error: ${j.error.slice(0, 500)}`)
}

const segments = listStoryToDateSegments(db, logbook!.id, {
  includeHidden: true,
  includeBroken: true,
})
console.log(`\nsegments (${segments.length}):`)
for (const s of segments) {
  console.log(
    `  seq ${s.seq} [${s.kind}] content=${s.content?.trim() ? 'yes' : 'no'} broken=${s.broken} coverage=${s.coverageThroughIcPost ?? '—'}`,
  )
}
