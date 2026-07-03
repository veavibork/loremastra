/** One-off stats: npx tsx scripts/story-memory-stats.ts <storyId> */
import Database from "better-sqlite3";
import { join } from "node:path";

const storyId = process.argv[2];
if (!storyId) {
  console.error("Usage: npx tsx scripts/story-memory-stats.ts <storyId>");
  process.exit(1);
}

const db = new Database(join("data/stories", `${storyId}.sqlite`), { readonly: true });

const canonicalPosts = db
  .prepare(
    `SELECT COUNT(*) AS n FROM page p
     JOIN text t ON t.id = p.selected_text_id
     WHERE t.gen_package IS NOT NULL AND TRIM(t.gen_package) != ''`
  )
  .get() as { n: number };

const extracts = db.prepare(`SELECT COUNT(*) AS n FROM text WHERE gen_extract IS NOT NULL`).get() as { n: number };

const visibleExtracts = db
  .prepare(
    `SELECT COUNT(*) AS n FROM page p
     JOIN text t ON t.id = p.selected_text_id
     WHERE t.gen_extract IS NOT NULL AND p.hidden = 0`
  )
  .get() as { n: number };

const compressNoModel = db
  .prepare(
    `SELECT COUNT(*) AS n FROM jobs
     WHERE job_type = 'compress' AND status = 'done' AND (model IS NULL OR model = '')`
  )
  .get() as { n: number };

const compressDone = db
  .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE job_type = 'compress' AND status = 'done'`)
  .get() as { n: number };

const archiveDurations = db
  .prepare(
    `SELECT AVG((julianday(finished_at) - julianday(started_at)) * 86400) AS avgSec,
            MAX((julianday(finished_at) - julianday(started_at)) * 86400) AS maxSec
     FROM jobs WHERE job_type = 'archive' AND status = 'done' AND started_at IS NOT NULL`
  )
  .get() as { avgSec: number | null; maxSec: number | null };

const compressPending = db
  .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE job_type = 'compress' AND status = 'pending'`)
  .get() as { n: number };

const compressRunning = db
  .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE job_type = 'compress' AND status = 'running'`)
  .get() as { n: number };

console.log(
  JSON.stringify(
    {
      storyId,
      canonicalPosts: canonicalPosts.n,
      extractsTotal: extracts.n,
      extractsVisible: visibleExtracts.n,
      compressJobsDone: compressDone.n,
      compressPending: compressPending.n,
      compressRunning: compressRunning.n,
      compressDoneWithoutModel: compressNoModel.n,
      archiveAvgSec: archiveDurations.avgSec != null ? Math.round(archiveDurations.avgSec) : null,
      archiveMaxSec: archiveDurations.maxSec != null ? Math.round(archiveDurations.maxSec) : null,
    },
    null,
    2
  )
);
