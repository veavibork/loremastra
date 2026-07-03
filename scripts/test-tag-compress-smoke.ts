/**
 * In-process smoke tests for Phase 2–3 (compress shortcuts, tag query activation).
 * Run: npx tsx scripts/test-tag-compress-smoke.ts
 */
import { getStoryDb } from "../src/db/story-db.js";
import { createBook } from "../src/db/book-store.js";
import { createPageWithText } from "../src/db/content-store.js";
import { createTag } from "../src/db/tag-store.js";
import { fillTextExtract } from "../src/db/text-store.js";
import { indexTextAgainstAllTags, reindexTagAcrossBook } from "../src/services/tag-index.js";
import { activateTagsFromQuery, buildTagQueryText, textForTagMatching } from "../src/services/tag-retrieval.js";
import {
  tryTrivialCompress,
  tryShortVerbatimCompress,
  validateCompressSummary,
  fallbackNarrativeSummary,
} from "../src/services/compress-worker.js";
import { listChronologicalPages } from "../src/db/page-store.js";
import { getText } from "../src/db/text-store.js";
import { newId } from "../src/uuid.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`ok: ${message}`);
}

const db = getStoryDb(`smoke-tag-compress-${newId()}`);
const logbook = createBook(db, { bookType: "logbook" });

// --- compress shortcuts ---
const trivial = tryTrivialCompress("Thanks!");
assert(!!trivial, "trivial compress matches short ack");
assert(tryTrivialCompress("A".repeat(200)) === null, "long text skips trivial");

const verbatim = tryShortVerbatimCompress("user", "I walk toward the tavern.");
assert(!!verbatim, "short user line gets verbatim compress");

const bad = validateCompressSummary(
  `"She said hello and then walked away toward the market while the sun set over the hills." repeated many times `.repeat(8),
  `"hello"`,
  "agent"
);
assert(!bad.ok, "validation rejects single-quoted fragment");

const fb = fallbackNarrativeSummary("The knight entered the castle. Guards watched from the walls.");
assert(fb.length > 20, "fallback narrative produces text");

// --- tag indexing on genExtract ---
const tag = createTag(db, { bookId: logbook.id, name: "Dragon" });
const { page: p1, text: t1 } = createPageWithText(db, {
  bookId: logbook.id,
  prevPageId: null,
  role: "agent",
  genPackage: "The hero rested by the fire.",
});
fillTextExtract(db, t1.id, "A dragon appeared on the ridge.");
indexTextAgainstAllTags(db, logbook.id, t1.id);
reindexTagAcrossBook(db, tag.id);

const haystack = textForTagMatching(getText(db, t1.id)!);
assert(haystack.includes("dragon"), "textForTagMatching includes genExtract");

// --- query activation (KAI-style) ---
const { page: p2, text: t2 } = createPageWithText(db, {
  bookId: logbook.id,
  prevPageId: p1.id,
  role: "user",
  genPackage: "What about the Dragon?",
});
const pages = listChronologicalPages(db, logbook.id);
const query = buildTagQueryText(db, pages);
const active = activateTagsFromQuery(db, logbook.id, query);
assert(active.includes(tag.id), "query activates Dragon tag from user message");

console.log("\nAll tag/compress smoke checks passed.");
