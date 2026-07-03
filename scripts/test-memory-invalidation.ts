/**
 * In-process smoke test for Phase 1 memory invalidation (no HTTP / Featherless).
 * Run: npx tsx scripts/test-memory-invalidation.ts
 */
import { getStoryDb } from "../src/db/story-db.js";
import { createBook } from "../src/db/book-store.js";
import { createPageWithText, createRetryText } from "../src/db/content-store.js";
import { getPage } from "../src/db/page-store.js";
import { fillTextExtract, getText } from "../src/db/text-store.js";
import { listArchivesForBook } from "../src/db/archive-store.js";
import { listPendingJobs } from "../src/db/job-store.js";
import { finishJob } from "../src/db/job-store.js";
import { enqueueEligibleArchiveBlocks } from "../src/services/archive.js";
import { enqueueEligibleCompressJobs } from "../src/services/compression.js";
import {
  computeTextContentStamp,
  markCompressValid,
  onCanonicalTextChanged,
  postNeedsCompress,
} from "../src/services/memory-invalidation.js";
import { newId } from "../src/uuid.js";

const USER_ID = "019f1e21-c547-75b2-8bc1-47b4b6cfdbe6";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`ok: ${message}`);
}

const db = getStoryDb(`smoke-invalidation-${newId()}`);
const logbook = createBook(db, { bookType: "logbook" });

let prevId: string | null = null;
const pageIds: string[] = [];
for (let i = 0; i < 10; i++) {
  const { page, text } = createPageWithText(db, {
    bookId: logbook.id,
    prevPageId: prevId,
    role: i % 2 === 0 ? "user" : "agent",
    genPackage: `Post ${i} content with unique token POST${i}.`,
  });
  prevId = page.id;
  pageIds.push(page.id);
  if (i < 8) {
    fillTextExtract(db, text.id, `Compressed summary for post ${i}.`);
    markCompressValid(db, page.id, text.id);
  }
}

const oldPageId = pageIds[2]!;
const oldPage = getPage(db, oldPageId)!;
const oldText = getText(db, oldPage.selectedTextId!)!;

assert(!postNeedsCompress(oldPage, oldText), "pre-edit compress is valid");

const edited = createRetryText(db, {
  pageId: oldPageId,
  priorTextId: oldText.id,
  role: oldText.role,
  genPackage: "Post 2 REVISED content.",
});
onCanonicalTextChanged(db, USER_ID, logbook.id, oldPageId);

const editedPage = getPage(db, oldPageId)!;
const editedText = getText(db, edited.id)!;
assert(postNeedsCompress(editedPage, editedText), "post-edit marks compress stale");
const compressJobs = listPendingJobs(db).filter((j) => j.jobType === "compress" && j.targetTextId === edited.id);
assert(compressJobs.length >= 1, "compress job queued for edited post");

enqueueEligibleCompressJobs(db, USER_ID, logbook.id);
assert(
  listPendingJobs(db).some((j) => j.jobType === "compress" && j.targetTextId === edited.id),
  "enqueue walk still targets deep stale post"
);

finishJob(db, compressJobs[0]!.id, "done");
fillTextExtract(db, edited.id, "Revised post 2 summary.");
markCompressValid(db, oldPageId, edited.id);
assert(!postNeedsCompress(getPage(db, oldPageId)!, getText(db, edited.id)!), "after recompress stamp valid");

for (let i = 8; i < 10; i++) {
  const p = getPage(db, pageIds[i]!)!;
  const t = getText(db, p.selectedTextId!)!;
  if (postNeedsCompress(p, t)) {
    fillTextExtract(db, t.id, `Compressed summary for post ${i}.`);
    markCompressValid(db, p.id, t.id);
  }
}
enqueueEligibleArchiveBlocks(db, USER_ID, logbook.id);
const archivesBefore = listArchivesForBook(db, logbook.id).length;
assert(archivesBefore >= 1, "archive block exists for 10 compressed posts");

createRetryText(db, {
  pageId: pageIds[4]!,
  priorTextId: getPage(db, pageIds[4]!)!.selectedTextId!,
  role: "agent",
  genPackage: "Post 4 totally changed.",
});
onCanonicalTextChanged(db, USER_ID, logbook.id, pageIds[4]!);
const archivesAfter = listArchivesForBook(db, logbook.id);
assert(
  archivesAfter.length < archivesBefore || archivesAfter.every((a) => !a.summary),
  "edit inside archive window invalidated archives"
);

const stamp1 = computeTextContentStamp(getText(db, edited.id)!);
const stamp2 = computeTextContentStamp(getText(db, edited.id)!);
assert(stamp1 === stamp2 && stamp1 !== null, "content stamp is deterministic");

// Gap enqueue: compressed band near head must not block deeper stale posts.
const gapDb = getStoryDb(`smoke-compress-gap-${newId()}`);
const gapLog = createBook(gapDb, { bookType: "logbook" });
let gapPrev: string | null = null;
const gapPageIds: string[] = [];
for (let i = 0; i < 12; i++) {
  const { page, text } = createPageWithText(gapDb, {
    bookId: gapLog.id,
    prevPageId: gapPrev,
    role: i % 2 === 0 ? "user" : "agent",
    genPackage: `Gap post ${i}.`,
  });
  gapPrev = page.id;
  gapPageIds.push(page.id);
  if (i >= 5) {
    fillTextExtract(gapDb, text.id, `Summary ${i}.`);
    markCompressValid(gapDb, page.id, text.id);
  }
}
gapDb.prepare(`DELETE FROM jobs WHERE job_type = 'compress'`).run();
enqueueEligibleCompressJobs(gapDb, USER_ID, gapLog.id);
const gapQueued = listPendingJobs(gapDb).filter((j) => j.jobType === "compress");
assert(gapQueued.length >= 5, "enqueue reaches stale posts past a valid compress band near head");

console.log("\nAll memory-invalidation smoke checks passed.");
