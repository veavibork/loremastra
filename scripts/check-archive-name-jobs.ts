/** VM/local: npx tsx scripts/check-archive-name-jobs.ts [storyId] */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const storyId = process.argv[2]
const dir = join('data/stories')
const files = storyId
  ? [`${storyId}.sqlite`]
  : readdirSync(dir).filter((f) => f.endsWith('.sqlite'))

for (const file of files) {
  const path = join(dir, file)
  let db: Database.Database
  try {
    db = new Database(path, { readonly: true })
  } catch {
    continue
  }
  console.log(`\n=== ${file} ===`)
  const counts = db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM jobs WHERE job_type = 'archive-name' GROUP BY status ORDER BY status`,
    )
    .all() as { status: string; n: number }[]
  if (!counts.length) {
    console.log('(no archive-name jobs)')
    db.close()
    continue
  }
  console.log('counts:', counts)
  const recent = db
    .prepare(
      `SELECT finished_at, status, model, substr(COALESCE(error, ''), 1, 220) AS error
       FROM jobs WHERE job_type = 'archive-name'
       ORDER BY COALESCE(finished_at, created_at) DESC LIMIT 25`,
    )
    .all()
  console.log('recent:', JSON.stringify(recent, null, 2))
  const unnamed = db
    .prepare(
      `SELECT COUNT(*) AS n FROM archive a
       WHERE a.summary IS NOT NULL AND trim(a.summary) != '' AND (a.name IS NULL OR trim(a.name) = '')`,
    )
    .get() as { n: number }
  console.log('archives with summary but no name:', unnamed.n)
  db.close()
}
