/**
 * Repair story-to-date coverage post numbers after absolute-index migration.
 * Post numbers are derived at runtime; only segment metadata may drift.
 *
 *   npx tsx scripts/repair-story-post-index.ts <storyId>           # report drift
 *   npx tsx scripts/repair-story-post-index.ts <storyId> --fix     # sync stored N from coveragePageId
 *   npx tsx scripts/repair-story-post-index.ts <storyId> --delete-segments
 *   npx tsx scripts/repair-story-post-index.ts <storyId> --delete-segments --requeue
 */
import { getGlobalDb } from "../src/db/global-db.js";
import { getStoryDb } from "../src/db/story-db.js";
import { getStory } from "../src/db/story-store.js";
import { getBookByType } from "../src/db/book-store.js";
import {
  deleteStoryToDateSegment,
  listStoryToDateSegments,
  setStoryToDateSegmentCoverage,
} from "../src/db/story-to-date-store.js";
import { cancelPendingJobsForStoryToDate } from "../src/db/job-store.js";
import { buildChainPostIndex, countChainPosts, resolveChainPostNumber } from "../src/services/post-index.js";
import { enqueueEligibleStoryToDateJob, enqueuePendingStoryToDateJobs } from "../src/services/story-to-date.js";

const storyId = process.argv[2];
if (!storyId) {
  console.error("Usage: npx tsx scripts/repair-story-post-index.ts <storyId> [--fix] [--delete-segments] [--requeue]");
  process.exit(1);
}

const fix = process.argv.includes("--fix");
const deleteSegments = process.argv.includes("--delete-segments");
const requeue = process.argv.includes("--requeue");

const globalDb = getGlobalDb();
const story = getStory(globalDb, storyId);
if (!story) {
  console.error(`Story not found: ${storyId}`);
  process.exit(1);
}

const db = getStoryDb(storyId);
const logbook = getBookByType(db, "logbook");
if (!logbook) {
  console.error("No logbook on story");
  process.exit(1);
}

const chain = buildChainPostIndex(db, logbook.id);
console.log(`Story: ${story.name} (${storyId})`);
console.log(`Chain: ${chain.length} posts (${chain.filter((e) => e.hidden).length} hidden)`);
console.log(`Head post #: ${countChainPosts(db, logbook.id)}`);

const segments = listStoryToDateSegments(db, logbook.id, { includeHidden: true, includeBroken: true });
console.log(`Segments: ${segments.length}`);

if (deleteSegments) {
  for (const seg of segments) {
    cancelPendingJobsForStoryToDate(db, seg.id);
    deleteStoryToDateSegment(db, seg.id);
    console.log(`  deleted seq ${seg.seq} [${seg.kind}]`);
  }
  console.log("All segments deleted.");
} else {
  for (const seg of segments) {
    const fromCoveragePage = seg.coveragePageId
      ? resolveChainPostNumber(db, logbook.id, seg.coveragePageId)
      : null;
    const fromCeilingPage = seg.inputCeilingPageId
      ? resolveChainPostNumber(db, logbook.id, seg.inputCeilingPageId)
      : null;
    const storedCoverage = seg.coverageThroughIcPost;
    const storedCeiling = seg.inputCeilingIcPost;

    const coverageDrift =
      fromCoveragePage != null && storedCoverage != null && fromCoveragePage !== storedCoverage;
    const ceilingDrift =
      fromCeilingPage != null && storedCeiling != null && fromCeilingPage !== storedCeiling;

    console.log(
      `  seq ${seg.seq} [${seg.kind}] coverage stored=${storedCoverage ?? "—"} page→${fromCoveragePage ?? "—"}${coverageDrift ? " DRIFT" : ""}` +
        ` ceiling stored=${storedCeiling ?? "—"} page→${fromCeilingPage ?? "—"}${ceilingDrift ? " DRIFT" : ""}`
    );

    if (fix && seg.coveragePageId && fromCoveragePage != null) {
      setStoryToDateSegmentCoverage(db, seg.id, {
        coverageThroughIcPost: fromCoveragePage,
        coveragePageId: seg.coveragePageId,
      });
      console.log(`    fixed coverage → ${fromCoveragePage}`);
    }
    if (fix && seg.inputCeilingPageId && fromCeilingPage != null && fromCeilingPage !== storedCeiling) {
      db.prepare(
        `UPDATE story_to_date_segment SET input_ceiling_ic_post = ? WHERE id = ?`
      ).run(fromCeilingPage, seg.id);
      console.log(`    fixed ceiling → ${fromCeilingPage}`);
    }
  }
}

if (requeue) {
  enqueueEligibleStoryToDateJob(db, story.ownerUserId, logbook.id, storyId);
  enqueuePendingStoryToDateJobs(db, story.ownerUserId, logbook.id);
  console.log("Re-enqueued story-to-date jobs.");
}

if (!deleteSegments && !fix && segments.some((s) => {
  const n = s.coveragePageId ? resolveChainPostNumber(db, logbook.id, s.coveragePageId) : null;
  return n != null && s.coverageThroughIcPost != null && n !== s.coverageThroughIcPost;
})) {
  console.log("\nDrift detected. Run with --fix to sync from page anchors, or --delete-segments --requeue for a clean regen.");
} else if (deleteSegments && requeue) {
  console.log("\nClean slate — pipeline will rebuild archives with absolute indexing.");
}
