/**
 * Clear stale memory artifacts and re-enqueue compress + archive pipeline.
 *
 * Run while the app is up (or restart after) so the pipeline runner drains the queue.
 *
 *   npx tsx scripts/reset-memory-queue.ts <storyId> [userId]
 */
import { getGlobalDb } from "../src/db/global-db.js";
import { getStoryDb, closeStoryDb } from "../src/db/story-db.js";
import { getStory } from "../src/db/story-store.js";
import { getBookByType } from "../src/db/book-store.js";
import { listChronologicalPages, setMemoryContentStamp } from "../src/db/page-store.js";
import { clearTextExtract } from "../src/db/text-store.js";
import { deleteArchive, listArchivesForBook } from "../src/db/archive-store.js";
import { enqueueMemoryPipeline } from "../src/services/memory-manifest.js";
import { nowIso } from "../src/db/time.js";
import { trackStoryDb } from "../src/queue/pipeline-runner.js";

const DEFAULT_USER_ID = "019f1e21-c547-75b2-8bc1-47b4b6cfdbe6";

function resetMemoryQueue(
  db: ReturnType<typeof getStoryDb>,
  userId: string,
  logbookId: string
): { clearedExtracts: number; deletedArchives: number; cancelledJobs: number; pendingJobs: number } {
  const cancelResult = db
    .prepare(
      `UPDATE jobs SET status = 'cancelled', finished_at = ?, error = COALESCE(error, 'reset by reset-memory-queue')
       WHERE status IN ('pending', 'running') AND job_type IN ('compress', 'archive')`
    )
    .run(nowIso());

  const archives = listArchivesForBook(db, logbookId);
  for (const archive of archives) {
    deleteArchive(db, archive.id);
  }

  let clearedExtracts = 0;
  for (const page of listChronologicalPages(db, logbookId)) {
    if (page.hidden || !page.selectedTextId) continue;
    setMemoryContentStamp(db, page.id, null);
    clearTextExtract(db, page.selectedTextId);
    clearedExtracts++;
  }

  const pendingJobs = enqueueMemoryPipeline(db, userId, logbookId);

  return {
    clearedExtracts,
    deletedArchives: archives.length,
    cancelledJobs: cancelResult.changes,
    pendingJobs,
  };
}

function main(): void {
  const storyId = process.argv[2];
  const userId = process.argv[3] ?? DEFAULT_USER_ID;

  if (!storyId) {
    console.error("Usage: npx tsx scripts/reset-memory-queue.ts <storyId> [userId]");
    process.exit(1);
  }

  const globalDb = getGlobalDb();
  const story = getStory(globalDb, storyId);
  if (!story) {
    console.error(`Story not found: ${storyId}`);
    process.exit(1);
  }

  const db = getStoryDb(storyId);
  const logbook = getBookByType(db, "logbook");
  if (!logbook) {
    console.error("Story has no logbook");
    process.exit(1);
  }

  trackStoryDb(storyId, db);

  const result = resetMemoryQueue(db, userId, logbook.id);
  console.log(JSON.stringify({ storyId, logbookId: logbook.id, ...result }, null, 2));
  console.log("\nMemory queue reset — compress/archive jobs enqueued. Pipeline will regen summaries.");
}

main();
