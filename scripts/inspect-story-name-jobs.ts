#!/usr/bin/env npx tsx
/** Inspect story-name job history for a story. */
import { getGlobalDb } from '../src/db/global-db.js'
import { getStoryDb } from '../src/db/story-db.js'
import { getBookByType } from '../src/db/book-store.js'
import { getPage } from '../src/db/page-store.js'
import { DEFAULT_STORY_NAME, getStory } from '../src/db/story-store.js'
import { resolveIcStartPageId } from '../src/services/kickoff.js'

const storyId = process.argv[2] ?? '019f25e0-219c-7189-b481-9f389a9a3c39'

const story = getStory(getGlobalDb(), storyId)
const db = getStoryDb(storyId)

const logbook = getBookByType(db, 'logbook')!
const icStartPageId = resolveIcStartPageId(db, logbook.id)

console.log('story name:', story?.name)
console.log('still default?:', story?.name === DEFAULT_STORY_NAME)
console.log('IC start page:', icStartPageId)

if (icStartPageId) {
  const page = getPage(db, icStartPageId)
  console.log('kickoff selectedTextId:', page?.selectedTextId)
  console.log('kickoff has prose:', !!page?.selectedTextId)
}

const jobs = db
  .prepare(
    `SELECT id, status, error, created_at, finished_at, target_text_id
     FROM jobs WHERE job_type = 'story-name' ORDER BY created_at`,
  )
  .all() as {
  id: string
  status: string
  error: string | null
  created_at: string
  finished_at: string | null
  target_text_id: string | null
}[]

console.log(`\nstory-name jobs: ${jobs.length}`)
for (const j of jobs) {
  console.log(
    `  ${j.status} ${j.created_at} text=${j.target_text_id?.slice(0, 8) ?? '—'} ${j.error ?? ''}`,
  )
}

if (icStartPageId) {
  const kickoffPage = getPage(db, icStartPageId)
  if (kickoffPage) {
    const textIds = db.prepare(`SELECT id FROM text WHERE page_id = ?`).all(kickoffPage.id) as {
      id: string
    }[]
    console.log(`\nkickoff page texts: ${textIds.length}`)
    for (const { id } of textIds) {
      const proseJobs = db
        .prepare(
          `SELECT job_type, status, created_at FROM jobs WHERE target_text_id = ? ORDER BY created_at`,
        )
        .all(id) as { job_type: string; status: string; created_at: string }[]
      if (proseJobs.length) {
        console.log(
          `  text ${id.slice(0, 8)}: ${proseJobs.map((j) => `${j.job_type}/${j.status}`).join(', ')}`,
        )
      }
    }
  }
}

const storyMeta = getStory(getGlobalDb(), storyId)
console.log('\nstory created:', storyMeta?.createdAt ?? '—')
