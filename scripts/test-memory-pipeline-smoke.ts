/**
 * End-to-end memory pipeline smoke test — in-process + HTTP via ephemeral server.
 * No Playwright, no DevTools, no LLM calls (trivial compress + manual extract fill).
 *
 * Run: npx tsx scripts/test-memory-pipeline-smoke.ts
 */
import { unlinkSync } from "node:fs";
import { getGlobalDb } from "../src/db/global-db.js";
import { getStoryDb, closeStoryDb } from "../src/db/story-db.js";
import { createStory, deleteStory, getStory } from "../src/db/story-store.js";
import { createBook, getBookByType, getTagScopeBookId } from "../src/db/book-store.js";
import { createPageWithText, createRetryText } from "../src/db/content-store.js";
import { getPage, listChronologicalPages, findHeadPageId } from "../src/db/page-store.js";
import { fillTextExtract, getText } from "../src/db/text-store.js";
import { createTag } from "../src/db/tag-store.js";
import { createWorldbookEntry } from "../src/db/worldbook-store.js";
import { listArchivesForBook, fillArchiveSummary } from "../src/db/archive-store.js";
import { setStoryPhase, setKickoffPageId } from "../src/db/story-state-store.js";
import { recordHistoryEvent, undoHistory } from "../src/db/history-store.js";
import { enqueueEligibleCompressJobs } from "../src/services/compression.js";
import { enqueueEligibleArchiveBlocks } from "../src/services/archive.js";
import {
  markCompressValid,
  onCanonicalTextChanged,
  postNeedsCompress,
} from "../src/services/memory-invalidation.js";
import { indexTextAgainstAllTags, reindexTagAcrossBook } from "../src/services/tag-index.js";
import { assembleAuthorPrompt } from "../src/services/history.js";
import { activateTagsFromQuery, buildTagQueryText } from "../src/services/tag-retrieval.js";
import { buildArchiveUserPrompt } from "../src/services/archive-worker.js";
import {
  backfillContentStamps,
  buildMemoryManifest,
  reindexAllMemoryTags,
} from "../src/services/memory-manifest.js";
import { tryTrivialCompress } from "../src/services/compress-worker.js";
import { newId } from "../src/uuid.js";

const USER_ID = "019f1e21-c547-75b2-8bc1-47b4b6cfdbe6";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`ok: ${message}`);
}

function compressPage(db: ReturnType<typeof getStoryDb>, pageId: string, textId: string, summary: string): void {
  fillTextExtract(db, textId, summary);
  markCompressValid(db, pageId, textId);
  const page = getPage(db, pageId)!;
  indexTextAgainstAllTags(db, getTagScopeBookId(db, page.bookId), textId);
}

// ---------------------------------------------------------------------------
// In-process integration
// ---------------------------------------------------------------------------

function runInProcessSmoke(): void {
  console.log("\n=== in-process memory pipeline ===\n");

  const globalDb = getGlobalDb();
  const story = createStory(globalDb, { ownerUserId: USER_ID, name: `smoke-pipeline-${newId().slice(0, 8)}` });
  const storyId = story.id;
  const db = getStoryDb(storyId);

  const gameBook = createBook(db, { bookType: "game" });
  const logbook = createBook(db, { bookType: "logbook", parentBookId: gameBook.id });
  const worldbook = createBook(db, { bookType: "worldbook", parentBookId: gameBook.id });

  createWorldbookEntry(db, {
    bookId: worldbook.id,
    entryType: "content",
    content: "A fantasy realm where ancient Dragons guard mountain passes.",
  });
  const rosterEntry = createWorldbookEntry(db, {
    bookId: worldbook.id,
    entryType: "roster",
    content: "Dragon — an ancient wyrm, scales like burnished copper, speaks in riddles.",
  });
  indexTextAgainstAllTags(db, getTagScopeBookId(db, worldbook.id), rosterEntry.currentTextId);

  const dragonTag = createTag(db, { bookId: gameBook.id, name: "Dragon" });
  reindexTagAcrossBook(db, dragonTag.id);

  let prevId: string | null = null;
  const pageIds: string[] = [];
  for (let i = 0; i < 20; i++) {
    const role = i % 2 === 0 ? "user" : "agent";
    const content =
      role === "user"
        ? i === 19
          ? "I cautiously ask the Dragon about the mountain pass."
          : `Player action ${i} near the Dragon's lair.`
        : `Narrator response ${i} describing the Dragon's lair and surroundings.`;

    const { page, text } = createPageWithText(db, {
      bookId: logbook.id,
      prevPageId: prevId,
      role,
      genPackage: content,
    });
    prevId = page.id;
    pageIds.push(page.id);
    indexTextAgainstAllTags(db, gameBook.id, text.id);

    const trivial = tryTrivialCompress(content);
    const summary = trivial?.summary ?? `Compressed: ${content.slice(0, 80)}`;
    compressPage(db, page.id, text.id, summary);
  }

  const kickoffPageId = pageIds[0]!;
  setKickoffPageId(db, kickoffPageId);
  setStoryPhase(db, "story");

  enqueueEligibleCompressJobs(db, USER_ID, logbook.id);
  enqueueEligibleArchiveBlocks(db, USER_ID, logbook.id);

  const archivesBefore = listArchivesForBook(db, logbook.id);
  assert(archivesBefore.length >= 3, "three overlapping archive blocks for 20 compressed posts");

  const firstArchive = archivesBefore[0]!;
  fillArchiveSummary(db, firstArchive.id, "Earlier: the party explored the Dragon's lair.");
  const thirdArchive = archivesBefore[2]!;
  const archivePrompt = buildArchiveUserPrompt(db, thirdArchive.id);
  assert(archivePrompt.includes("Compressed:"), "archive prompt includes member lines");
  assert(archivePrompt.includes("Earlier story summary"), "non-overlapping prior archive included in prompt");

  const headId = findHeadPageId(db, logbook.id)!;
  const pages = listChronologicalPages(db, logbook.id).filter((p) => !p.hidden);
  const query = buildTagQueryText(db, pages);
  const activeTags = activateTagsFromQuery(db, gameBook.id, query);
  assert(activeTags.includes(dragonTag.id), "KAI-style query activates Dragon tag");

  const messages = assembleAuthorPrompt(db, USER_ID, logbook.id, headId);
  const blob = JSON.stringify(messages);
  assert(blob.includes("Dragon") && blob.includes("ROSTER"), "assembled prompt includes Dragon roster from query activation");

  const editPageId = pageIds[4]!;
  const editPage = getPage(db, editPageId)!;
  const priorText = getText(db, editPage.selectedTextId!)!;
  const revisedText = createRetryText(db, {
    pageId: editPageId,
    priorTextId: priorText.id,
    role: priorText.role,
    genPackage: "REVISED: the Dragon roars from the cliff.",
  });
  recordHistoryEvent(db, {
    kind: "text",
    pageId: editPageId,
    fromValue: priorText.id,
    toValue: revisedText.id,
  });
  onCanonicalTextChanged(db, USER_ID, logbook.id, editPageId);
  assert(postNeedsCompress(getPage(db, editPageId)!, revisedText), "edit invalidates compress stamp");

  compressPage(db, editPageId, revisedText.id, "Revised compress: Dragon roars.");
  assert(listArchivesForBook(db, logbook.id).length >= 1, "archives exist after edit recompress");

  const undoResult = undoHistory(db);
  assert(!!undoResult?.canonicalTextPageId, "undo returns canonical text page for invalidation");
  if (undoResult?.canonicalTextPageId) {
    onCanonicalTextChanged(db, USER_ID, logbook.id, undoResult.canonicalTextPageId);
  }
  assert(
    postNeedsCompress(getPage(db, editPageId)!, getText(db, priorText.id)!),
    "undo restores prior text and marks compress stale"
  );

  const manifest = buildMemoryManifest(db, logbook.id);
  assert(manifest.postCount === 20, "manifest reports all posts");
  assert(manifest.needsCompressCount >= 1, "manifest flags stale posts");

  const stamps = backfillContentStamps(db);
  assert(stamps.stamped + stamps.skipped === 20, "backfill stamps walks all posts");

  reindexAllMemoryTags(db, logbook.id);

  const filePath = story.filePath;
  closeStoryDb(storyId);
  deleteStory(globalDb, storyId);
  try {
    unlinkSync(filePath);
  } catch {
    /* file may not exist in some test envs */
  }
  assert(getStory(globalDb, storyId) === null, "cleanup deleted smoke story");

  console.log("\nIn-process checks passed.\n");
}

// ---------------------------------------------------------------------------
// Also run HTTP + existing unit smokes
// ---------------------------------------------------------------------------

async function runExistingSmokes(): Promise<void> {
  console.log("=== existing smoke scripts ===\n");
  const { execSync } = await import("node:child_process");
  execSync("npx tsx scripts/test-memory-pipeline-http.ts", { stdio: "inherit", cwd: process.cwd() });
  execSync("npx tsx scripts/test-memory-invalidation.ts", { stdio: "inherit", cwd: process.cwd() });
  execSync("npx tsx scripts/test-tag-compress-smoke.ts", { stdio: "inherit", cwd: process.cwd() });
}

async function main(): Promise<void> {
  runInProcessSmoke();
  await runExistingSmokes();
  console.log("\nAll memory pipeline smoke tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
