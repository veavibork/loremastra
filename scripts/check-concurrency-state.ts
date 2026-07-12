/** Feed + archive slot_cost snapshot: npx tsx scripts/check-concurrency-state.ts [userId] [storyId] */
import { getGlobalDb } from '../src/db/global-db.js'
import { getStoryDb } from '../src/db/story-db.js'
import { getDecryptedFeatherlessKey } from '../src/db/user-store.js'
import {
  ensureConcurrencyFeedForUser,
  getConcurrencySnapshot,
  isFeedHealthy,
} from '../src/queue/concurrency-feed.js'
import { getQueueStatus } from '../src/queue/slots.js'

const userId = process.argv[2] ?? '019f1e21-c547-75b2-8bc1-47b4b6cfdbe6'
const storyId = process.argv[3] ?? '019f25e0-219c-7189-b481-9f389a9a3c39'

ensureConcurrencyFeedForUser(userId, getDecryptedFeatherlessKey(getGlobalDb(), userId) ?? '')

await new Promise((r) => setTimeout(r, 3000))

const db = getStoryDb(storyId)
const slotCosts = db
  .prepare(
    `SELECT slot_cost, status, COUNT(*) AS n FROM jobs WHERE job_type = 'archive' GROUP BY slot_cost, status ORDER BY slot_cost, status`,
  )
  .all()

console.log(
  JSON.stringify(
    {
      feedHealthy: isFeedHealthy(userId),
      snapshot: getConcurrencySnapshot(userId),
      queueStatus: getQueueStatus(userId),
      archiveJobsBySlotCost: slotCosts,
    },
    null,
    2,
  ),
)
