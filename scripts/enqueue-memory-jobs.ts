/** Enqueue archive jobs for eligible blocks: npx tsx scripts/enqueue-memory-jobs.ts <storyId> [userId] */
import { getBookByType } from '../src/db/book-store.js'
import { getStoryDb } from '../src/db/story-db.js'
import { listPendingJobs } from '../src/db/job-store.js'
import { enqueueMemoryPipeline } from '../src/services/context/manifest.js'
import { trackStoryDb } from '../src/queue/pipeline-runner.js'

const storyId = process.argv[2]
const userId = process.argv[3] ?? '019f1e21-c547-75b2-8bc1-47b4b6cfdbe6'

if (!storyId) {
  console.error('Usage: npx tsx scripts/enqueue-memory-jobs.ts <storyId> [userId]')
  process.exit(1)
}

const db = getStoryDb(storyId)
const logbook = getBookByType(db, 'logbook')
if (!logbook) {
  console.error('no logbook')
  process.exit(1)
}

trackStoryDb(storyId, db)
const pendingMemoryJobs = enqueueMemoryPipeline(db, userId, logbook.id, storyId)
const byType = listPendingJobs(db).reduce(
  (acc, j) => {
    acc[j.jobType] = (acc[j.jobType] ?? 0) + 1
    return acc
  },
  {} as Record<string, number>,
)

console.log(JSON.stringify({ storyId, pendingMemoryJobs, byType }, null, 2))
