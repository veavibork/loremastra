/** Quick job-status snapshot: npx tsx scripts/check-memory-jobs.ts <storyId> */
import Database from 'better-sqlite3'
import { join } from 'node:path'

const storyId = process.argv[2]
if (!storyId) {
  console.error('Usage: npx tsx scripts/check-memory-jobs.ts <storyId>')
  process.exit(1)
}

const db = new Database(join('data/stories', `${storyId}.sqlite`), { readonly: true })
const rows = db
  .prepare(
    `SELECT status, job_type, COUNT(*) AS n FROM jobs WHERE job_type IN ('compress', 'archive') GROUP BY status, job_type ORDER BY job_type, status`,
  )
  .all()
const extracts = db
  .prepare(`SELECT COUNT(*) AS n FROM text WHERE gen_extract IS NOT NULL`)
  .get() as { n: number }
const archives = db
  .prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN summary IS NOT NULL THEN 1 ELSE 0 END) AS filled FROM archive`,
  )
  .get() as {
  total: number
  filled: number
}
console.log(
  JSON.stringify({ storyId, jobs: rows, extractsWithSummary: extracts.n, archives }, null, 2),
)
