/** Failed archive job breakdown: npx tsx scripts/check-failed-archives.ts [storyId] */
import Database from 'better-sqlite3'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const storyFilter = process.argv[2]

function inspect(storyId: string) {
  const db = new Database(join('data/stories', `${storyId}.sqlite`), { readonly: true })
  const total = db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM jobs WHERE job_type = 'archive' GROUP BY status ORDER BY status`,
    )
    .all()
  const failed = db
    .prepare(
      `SELECT error, COUNT(*) AS n FROM jobs WHERE job_type = 'archive' AND status = 'failed' GROUP BY error ORDER BY n DESC LIMIT 15`,
    )
    .all()
  const recent = db
    .prepare(
      `SELECT id, created_at, error FROM jobs WHERE job_type = 'archive' AND status = 'failed' ORDER BY created_at DESC LIMIT 5`,
    )
    .all()
  const pendingArchives = db
    .prepare(`SELECT COUNT(*) AS n FROM archive WHERE summary IS NULL`)
    .get() as { n: number }
  const models = db
    .prepare(
      `SELECT model, status, COUNT(*) AS n FROM jobs WHERE job_type = 'archive' GROUP BY model, status ORDER BY status, n DESC`,
    )
    .all()
  const pendingJobs = db
    .prepare(
      `SELECT COUNT(*) AS n FROM jobs WHERE job_type = 'archive' AND status IN ('pending','running')`,
    )
    .get() as { n: number }
  return {
    storyId,
    total,
    failed,
    recent,
    pendingArchives: pendingArchives.n,
    pendingArchiveJobs: pendingJobs.n,
    models,
  }
}

if (storyFilter) {
  console.log(JSON.stringify(inspect(storyFilter), null, 2))
} else {
  for (const f of readdirSync('data/stories').filter((x) => x.endsWith('.sqlite'))) {
    const storyId = f.replace('.sqlite', '')
    const result = inspect(storyId)
    const hasFailed = (result.total as Array<{ status: string; n: number }>).some(
      (r) => r.status === 'failed',
    )
    if (hasFailed || result.pendingArchives > 0) {
      console.log(JSON.stringify(result, null, 2))
      console.log('---')
    }
  }
}
