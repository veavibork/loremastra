/**
 * End-to-end memory pipeline smoke test — in-process + HTTP via ephemeral server.
 * No Playwright, no DevTools, no LLM calls (manual archive fill where needed).
 *
 * Run: npx tsx scripts/test-memory-pipeline-smoke.ts
 */
import { unlinkSync } from "node:fs";
import { getGlobalDb } from "../src/db/global-db.js";
import { getStoryDb, closeStoryDb } from "../src/db/story-db.js";
import { createStory, deleteStory, getStory } from "../src/db/story-store.js";
import { createBook, getBookByType } from "../src/db/book-store.js";
import { createPageWithText, createRetryText } from "../src/db/content-store.js";
import { getPage, findHeadPageId } from "../src/db/page-store.js";
import { getText } from "../src/db/text-store.js";
import { createWorldbookEntry } from "../src/db/worldbook-store.js";
import { listArchivesForBook, fillArchiveSummary } from "../src/db/archive-store.js";
import { setStoryPhase, setKickoffPageId } from "../src/db/story-state-store.js";
import { recordHistoryEvent, undoHistory } from "../src/db/history-store.js";
import { enqueueEligibleArchiveBlocks } from "../src/services/archive.js";
import { onCanonicalTextChanged, postNeedsCompress } from "../src/services/memory-invalidation.js";
import { assembleAuthorPrompt } from "../src/services/history.js";
import { buildArchiveUserPrompt } from "../src/services/archive-worker.js";
import {
  backfillContentStamps,
  buildMemoryManifest,
} from "../src/services/memory-manifest.js";
import { newId } from "../src/uuid.js";

const USER_ID = "019f1e21-c547-75b2-8bc1-47b4b6cfdbe6";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`ok: ${message}`);
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
    content: "PC: Lex. Mid-forties, solid build.\nA fantasy realm where ancient Dragons guard mountain passes.",
  });
  createWorldbookEntry(db, {
    bookId: worldbook.id,
    entryType: "roster",
    content: "Dragon — an ancient wyrm, scales like burnished copper, speaks in riddles.",
  });

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
  }

  const kickoffPageId = pageIds[0]!;
  setKickoffPageId(db, kickoffPageId);
  setStoryPhase(db, "story");

  enqueueEligibleArchiveBlocks(db, USER_ID, logbook.id);

  const archivesBefore = listArchivesForBook(db, logbook.id);
  assert(archivesBefore.length >= 2, "two non-overlapping archive blocks for 20 posts with prose");

  const firstArchive = archivesBefore[0]!;
  fillArchiveSummary(db, firstArchive.id, "Earlier: the party explored the Dragon's lair.");
  const secondArchive = archivesBefore[1]!;
  const archivePrompt = buildArchiveUserPrompt(db, secondArchive.id);
  assert(archivePrompt.includes("Messages to archive"), "archive prompt uses full prose blob");
  assert(archivePrompt.includes('"role"'), "archive prompt JSON includes role labels");
  assert(archivePrompt.includes("Earlier story summary"), "non-overlapping prior archive included in prompt");
  assert(archivePrompt.includes("PC: Lex"), "archive prompt includes CONTENT PC line");

  const headId = findHeadPageId(db, logbook.id)!;

  const messages = assembleAuthorPrompt(db, USER_ID, logbook.id, headId);
  const blob = JSON.stringify(messages);
  assert(blob.includes("Dragon") && blob.includes("ROSTER"), "assembled prompt includes full worldbook roster entries");
  assert(blob.includes("[EVENT SUMMARY]") || blob.includes("Player action"), "assembled prompt uses verbose and/or event summaries");

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
  assert(!postNeedsCompress(getPage(db, editPageId)!, revisedText), "compression disabled after edit");
  enqueueEligibleArchiveBlocks(db, USER_ID, logbook.id);
  assert(listArchivesForBook(db, logbook.id).length >= 1, "archives exist after edit invalidation");

  const undoResult = undoHistory(db);
  assert(!!undoResult?.canonicalTextPageId, "undo returns canonical text page for invalidation");
  if (undoResult?.canonicalTextPageId) {
    onCanonicalTextChanged(db, USER_ID, logbook.id, undoResult.canonicalTextPageId);
  }
  assert(!postNeedsCompress(getPage(db, editPageId)!, priorText), "compression disabled after undo");

  const manifest = buildMemoryManifest(db, logbook.id);
  assert(manifest.postCount === 20, "manifest reports all posts");
  assert(manifest.needsCompressCount === 0, "manifest reports no compress backlog when compression disabled");

  const stamps = backfillContentStamps(db);
  assert(stamps.stamped + stamps.skipped === 20, "backfill stamps walks all posts");

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
