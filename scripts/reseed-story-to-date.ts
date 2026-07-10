#!/usr/bin/env npx tsx
/**
 * One-shot reseed of a story's STORY TO DATE with the current (C-quality) Editor prompt, then a
 * single fold pass so it starts bounded. Deletes the story's existing segments and regenerates
 * begins -> continues to the head (leaving the verbose tail), writing each segment to the DB.
 *
 * RUN WITH THE SERVICE STOPPED — it writes story_to_date_segment rows directly and needs the
 * Featherless concurrency slot free.
 *
 * Usage:
 *   npx tsx scripts/reseed-story-to-date.ts <storyId> --yes [--keep-recent N] [--no-fold]
 */
try { process.loadEnvFile(); } catch { /* no .env */ }

import { getGlobalDb } from "../src/db/global-db.js";
import { getStoryDb } from "../src/db/story-db.js";
import { getStory } from "../src/db/story-store.js";
import { getBookByType } from "../src/db/book-store.js";
import { getDecryptedFeatherlessKey } from "../src/db/user-store.js";
import { getAgentProfile } from "../src/services/agent-config.js";
import { completeChat, type ChatMessage } from "../src/inference/featherless.js";
import {
  buildStoryCorpus,
  formatCorpusForEditor,
  buildDefaultBeginsSystemPrompt,
  buildNextSceneContinuesSystemPrompt,
  buildSeamRetryUserMessage,
  shouldRetrySeamGate,
  extractStoryBlock,
  extractCoverage,
  mergeStoryToDate,
  sanitizeStoryBlockContent,
  STORY_BLOCK_DUPLICATE_OVERLAP_THRESHOLD,
  storyBlockWordOverlapRatio,
  stripStoryToDateWrapper,
  estimateTokens,
  MIN_VERBOSE_IC_POSTS,
  type StoryBlockKind,
} from "../src/services/story-to-date-corpus.js";
import { STORY_TO_DATE_INPUT_CUTOFF, enqueueEligibleFoldJob } from "../src/services/story-to-date.js";
import { executeStoryToDateFoldJob } from "../src/services/story-to-date-fold-worker.js";
import { buildChainPostIndex } from "../src/services/post-index.js";
import {
  listStoryToDateSegments,
  createStoryToDateSegment,
  fillStoryToDateSegment,
  deleteStoryToDateSegmentsFromSeq,
} from "../src/db/story-to-date-store.js";
import { claimNextJob, finishJob } from "../src/db/job-store.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function chat(editor: any, key: string, messages: ChatMessage[]): Promise<string> {
  const delays = [15000, 30000, 45000, 60000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await completeChat(editor, key, messages, { maxTokens: editor.responseLimit });
    } catch (err: any) {
      const is429 = err?.status === 429 || String(err?.message ?? "").includes("429");
      if (!is429 || attempt >= delays.length) throw err;
      console.log(`  (429 — waiting ${delays[attempt]! / 1000}s; is the service still running?)`);
      await sleep(delays[attempt]!);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const storyId = args[0];
  if (!storyId || !args.includes("--yes")) {
    console.error("usage: reseed-story-to-date.ts <storyId> --yes [--keep-recent N] [--no-fold]");
    console.error("  (--yes required — this DELETES and regenerates the story's STORY TO DATE)");
    process.exit(1);
  }
  const doFold = !args.includes("--no-fold");

  const globalDb = getGlobalDb();
  const story = getStory(globalDb, storyId);
  if (!story) throw new Error("story not found");
  const db = getStoryDb(storyId);
  const logbook = getBookByType(db, "logbook")!;
  const editor = getAgentProfile(story.ownerUserId, "editor");
  const apiKey = process.env.FEATHERLESS_API_KEY?.trim() || getDecryptedFeatherlessKey(globalDb, story.ownerUserId) || "";
  if (!apiKey) throw new Error("no Featherless API key");

  const existing = listStoryToDateSegments(db, logbook.id, { includeHidden: true, includeBroken: true });
  console.log(`Deleting ${existing.length} existing segments and regenerating…`);
  deleteStoryToDateSegmentsFromSeq(db, logbook.id, 0);

  const chain = buildChainPostIndex(db, logbook.id);
  const headPost = chain.length ? chain[chain.length - 1]!.postNumber : 0;

  let afterPageId: string | null = null;
  let priorCoverage: number | null = null;
  let seq = 0;

  for (; seq < 100; seq++) {
    const kind: StoryBlockKind = seq === 0 ? "begins" : "continues";
    const priorRows = listStoryToDateSegments(db, logbook.id).filter((s) => s.content?.trim() && !s.broken);
    const priorStoryToDate = kind === "continues" ? mergeStoryToDate(priorRows.map((s) => ({
      kind: s.kind, content: s.content!.trim(), coverageThroughPost: s.coverageThroughIcPost ?? 0, coveragePageId: s.coveragePageId,
    }))) : undefined;

    const corpus = buildStoryCorpus(db, storyId, logbook.id, {
      contextLimit: editor.contextLimit,
      responseLimit: editor.responseLimit,
      inputCutoff: STORY_TO_DATE_INPUT_CUTOFF,
      afterPageId: kind === "continues" ? afterPageId : null,
      priorStoryToDate,
    });
    if (corpus.includedPosts.length === 0) { console.log(`Reached head at coverage ${priorCoverage}.`); break; }
    if (kind === "continues" && corpus.posts.length <= MIN_VERBOSE_IC_POSTS) {
      console.log(`Only ${corpus.posts.length} posts left after ${priorCoverage} — leaving verbose tail.`);
      break;
    }

    const system = kind === "begins"
      ? buildDefaultBeginsSystemPrompt(corpus.inputCeilingPost)
      : buildNextSceneContinuesSystemPrompt(corpus.inputCeilingPost, priorCoverage);
    const corpusText = formatCorpusForEditor(corpus, corpus.includedPosts, true);
    const user = kind === "begins"
      ? `Compress the following into [STORY BEGINS]:\n\n${corpusText}`
      : `[STORY TO DATE]\n${stripStoryToDateWrapper(priorStoryToDate?.trim() || "(empty)")}\n\nNew log prose to fold in:\n\n${corpusText}`;
    const messages: ChatMessage[] = [{ role: "system", content: system }, { role: "user", content: user }];

    let committed = false;
    for (let attempt = 1; attempt <= 2 && !committed; attempt++) {
      let raw = await chat(editor, apiKey, messages);
      let block = extractStoryBlock(raw, kind);
      let coverage = extractCoverage(raw);
      if (block && coverage != null && corpus.inputCeilingPost != null && shouldRetrySeamGate(coverage, corpus.inputCeilingPost)) {
        const retry = [...messages, { role: "assistant" as const, content: raw }, { role: "user" as const, content: buildSeamRetryUserMessage(kind, coverage, corpus.inputCeilingPost) }];
        const rr = await chat(editor, apiKey, retry);
        const rb = extractStoryBlock(rr, kind); const rc = extractCoverage(rr);
        if (rb && rc != null && rc < coverage && rc <= corpus.inputCeilingPost) { block = rb; coverage = rc; }
      }
      if (!block || coverage == null) { console.log(`  seq ${seq} attempt ${attempt}: no block/coverage`); continue; }
      block = sanitizeStoryBlockContent(block);
      if (!block) { console.log(`  seq ${seq} attempt ${attempt}: empty after sanitization`); continue; }
      if (kind === "continues" && priorRows.length) {
        const priorBlock = priorRows[priorRows.length - 1]!.content!.trim();
        const overlap = storyBlockWordOverlapRatio(block, priorBlock);
        if (overlap >= STORY_BLOCK_DUPLICATE_OVERLAP_THRESHOLD) {
          console.log(`  seq ${seq} attempt ${attempt}: duplicate of prior (${(overlap * 100).toFixed(1)}% overlap)`);
          continue;
        }
      }
      if (corpus.inputCeilingPost != null && coverage > corpus.inputCeilingPost) { console.log(`  seq ${seq}: coverage>${corpus.inputCeilingPost}`); continue; }
      const chainEntry = buildChainPostIndex(db, logbook.id).find((e) => e.postNumber === coverage);
      if (!chainEntry || chainEntry.hidden) { console.log(`  seq ${seq}: coverage ${coverage} off visible chain`); continue; }
      const cp = corpus.includedPosts.find((p) => p.icPostNumber === coverage);
      if (!cp) { console.log(`  seq ${seq}: coverage ${coverage} not in input`); continue; }
      if (priorCoverage != null && coverage <= priorCoverage) { console.log(`  seq ${seq}: no advance past ${priorCoverage}`); continue; }

      const segment = createStoryToDateSegment(db, { bookId: logbook.id, kind, seq });
      fillStoryToDateSegment(db, segment.id, {
        content: block,
        coverageThroughIcPost: coverage,
        coveragePageId: cp.pageId,
        inputCeilingIcPost: corpus.inputCeilingPost ?? coverage,
        inputCeilingPageId: corpus.inputCeilingPageId ?? cp.pageId,
      });
      afterPageId = cp.pageId; priorCoverage = coverage; committed = true;
      console.log(`  seq ${seq} ${kind}: cov →${coverage}/${headPost} (${estimateTokens(block)} tok)`);
    }
    if (!committed) { console.log(`  seq ${seq}: FAILED — stopping regeneration.`); break; }
  }

  if (doFold) {
    const foldJobId = enqueueEligibleFoldJob(db, story.ownerUserId, logbook.id);
    if (foldJobId) {
      const job = claimNextJob(db, ["story-to-date-fold"]);
      if (job?.targetStoryToDateId) {
        console.log(`Folding deep past…`);
        await executeStoryToDateFoldJob(db, story.ownerUserId, logbook.id, job.targetStoryToDateId, apiKey);
        finishJob(db, job.id, "done");
      }
    }
  }

  const final = listStoryToDateSegments(db, logbook.id).filter((s) => s.content?.trim() && !s.broken);
  const total = final.reduce((a, s) => a + estimateTokens(s.content!), 0);
  console.log(`\nDone: ${final.length} segments, ${total} tok, coverage through ${final[final.length - 1]?.coverageThroughIcPost}/${headPost}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
