/**
 * In-process smoke test for Phase 1 memory invalidation (no HTTP / Featherless).
 * Run: npx tsx scripts/test-memory-invalidation.ts
 */
import { getStoryDb } from "../src/db/story-db.js";
import { createBook } from "../src/db/book-store.js";
import { createPageWithText, createRetryText } from "../src/db/content-store.js";
import { getPage } from "../src/db/page-store.js";
import { getText } from "../src/db/text-store.js";
import { listArchivesForBook } from "../src/db/archive-store.js";
import { listPendingJobs } from "../src/db/job-store.js";
import { enqueueEligibleArchiveBlocks } from "../src/services/archive.js";
import {
  computeTextContentStamp,
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
  const { page } = createPageWithText(db, {
    bookId: logbook.id,
    prevPageId: prevId,
    role: i % 2 === 0 ? "user" : "agent",
    genPackage: `Post ${i} content with unique token POST${i}.`,
  });
  prevId = page.id;
  pageIds.push(page.id);
}

const oldPageId = pageIds[2]!;
const oldPage = getPage(db, oldPageId)!;
const oldText = getText(db, oldPage.selectedTextId!)!;

assert(!postNeedsCompress(oldPage, oldText), "compression disabled — postNeedsCompress is always false");

const edited = createRetryText(db, {
  pageId: oldPageId,
  priorTextId: oldText.id,
  role: oldText.role,
  genPackage: "Post 2 REVISED content.",
});
onCanonicalTextChanged(db, USER_ID, logbook.id, oldPageId);

const editedPage = getPage(db, oldPageId)!;
const editedText = getText(db, edited.id)!;
assert(!postNeedsCompress(editedPage, editedText), "compression disabled after edit");
assert(
  listPendingJobs(db).every((j) => j.jobType !== "compress"),
  "no compress jobs queued on edit"
);
assert(editedPage.memoryContentStamp !== null, "edit updates content stamp");

enqueueEligibleArchiveBlocks(db, USER_ID, logbook.id);
const archivesBefore = listArchivesForBook(db, logbook.id).length;
assert(archivesBefore >= 1, "archive block exists for 10 posts with prose");

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

// Archive enqueue reaches full log without compress preconditions.
const gapDb = getStoryDb(`smoke-archive-gap-${newId()}`);
const gapLog = createBook(gapDb, { bookType: "logbook" });
let gapPrev: string | null = null;
for (let i = 0; i < 12; i++) {
  const { page } = createPageWithText(gapDb, {
    bookId: gapLog.id,
    prevPageId: gapPrev,
    role: i % 2 === 0 ? "user" : "agent",
    genPackage: `Gap post ${i}.`,
  });
  gapPrev = page.id;
}
enqueueEligibleArchiveBlocks(gapDb, USER_ID, gapLog.id);
const gapArchives = listArchivesForBook(gapDb, gapLog.id);
assert(gapArchives.length >= 1, "archive blocks enqueue from prose-only log");

console.log("\nAll memory-invalidation smoke checks passed.");
