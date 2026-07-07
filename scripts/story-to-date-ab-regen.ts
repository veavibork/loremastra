#!/usr/bin/env npx tsx
/**
 * A/B full-chain regeneration for the story-to-date Editor prompt.
 * Regenerates the ENTIRE [STORY TO DATE] for a story twice — once per prompt variant —
 * and writes per-block metrics + a comparison summary. Standalone: no DB writes, all
 * artifacts to disk. Featherless (flat-rate) calls only; safe to run in background.
 *
 * Usage:
 *   LOREMASTER_DATA_DIR=data/vm-sync npx tsx scripts/story-to-date-ab-regen.ts <storyId> [--max-blocks N] [--only A|B]
 *
 * Variants:
 *   A = shipped C prompt (INCLUDE_EXCLUDE_GUIDANCE as committed)
 *   B = C + sharpened EXCLUDE (adds task-assignment / status-update chatter to the exclude list)
 */
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

try {
  process.loadEnvFile();
} catch {
  /* no .env */
}

import { getGlobalDb } from "../src/db/global-db.js";
import { getStoryDb } from "../src/db/story-db.js";
import { getStory } from "../src/db/story-store.js";
import { getBookByType } from "../src/db/book-store.js";
import { getDecryptedFeatherlessKey } from "../src/db/user-store.js";
import { getAgentProfile } from "../src/services/agent-config.js";
import { completeChat, type ChatMessage } from "../src/inference/featherless.js";
import {
  INCLUDE_EXCLUDE_GUIDANCE,
  buildDefaultBeginsSystemPrompt,
  buildDefaultContinuesSystemPrompt,
  buildSeamRetryUserMessage,
  buildStoryCorpus,
  extractCoverage,
  extractStoryBlock,
  formatCorpusForEditor,
  mergeStoryToDate,
  shouldRetrySeamGate,
  stripStoryToDateWrapper,
  estimateTokens,
  MIN_VERBOSE_IC_POSTS,
  type StoryBlockKind,
  type StoryToDateSegment,
} from "../src/services/story-to-date-corpus.js";
import { buildChainPostIndex } from "../src/services/post-index.js";

const INPUT_CUTOFF = 0.8;
const MAX_ATTEMPTS = 2;

// Variant B (v2 — "sharp"): the enumerated exclude list (v1) made output ~31% WORDIER,
// so instead of adding clauses we retarget the existing one clause with a stronger verb
// and examples that name the leak categories (task assignments, status check-ins). Same
// footprint as A — no net prompt growth.
const VARIANT_B_GUIDANCE = INCLUDE_EXCLUDE_GUIDANCE.replace(
  "logistics and coordination chatter (who texted whom, who fetched what);",
  "logistics, task assignments, and status chatter (who's doing what, who reported in, who fetched what) — omit these entirely;"
);

interface BlockMetric {
  seq: number;
  kind: StoryBlockKind;
  priorCoverage: number | null;
  inputCeilingPost: number | null;
  inputPosts: number;
  coverageThroughPost: number;
  words: number;
  tokens: number;
  seamRetried: boolean;
  attempts: number;
}

function words(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

async function runVariant(
  label: string,
  guidance: string,
  ctx: {
    db: any;
    storyId: string;
    logbookId: string;
    editor: any;
    apiKey: string;
  },
  outDir: string,
  logFile: string,
  maxBlocks: number
): Promise<{ metrics: BlockMetric[]; segments: StoryToDateSegment[]; reachedHead: boolean; headPost: number }> {
  const { db, storyId, logbookId, editor, apiKey } = ctx;
  const log = (m: string) => {
    console.log(`[${label}] ${m}`);
    appendFileSync(logFile, `[${label}] ${m}\n`);
  };

  const chain = buildChainPostIndex(db, logbookId);
  const headPost = chain.length ? chain[chain.length - 1]!.postNumber : 0;

  const segments: StoryToDateSegment[] = [];
  const metrics: BlockMetric[] = [];
  let afterPageId: string | null = null;
  let priorCoverage: number | null = null;
  let reachedHead = false;

  for (let seq = 0; seq < maxBlocks; seq++) {
    const kind: StoryBlockKind = seq === 0 ? "begins" : "continues";
    const priorStoryToDate = kind === "continues" ? mergeStoryToDate(segments) : undefined;

    const corpus = buildStoryCorpus(db, storyId, logbookId, {
      contextLimit: editor.contextLimit,
      responseLimit: editor.responseLimit,
      inputCutoff: INPUT_CUTOFF,
      afterPageId: kind === "continues" ? afterPageId : null,
      priorStoryToDate,
    });

    if (corpus.includedPosts.length === 0) {
      log(`no posts left to fold in (afterCoverage=${priorCoverage}) — reached head.`);
      reachedHead = true;
      break;
    }
    // Production never compresses to the head: it keeps a verbose tail (MIN_VERBOSE_IC_POSTS)
    // and only fires when the Author prompt crosses 80%. Stop once the remaining uncovered
    // posts fit within that tail — that's the representative steady state, and it avoids
    // grinding on the final post the way a naive "cover everything" loop does.
    if (kind === "continues" && corpus.posts.length <= MIN_VERBOSE_IC_POSTS) {
      log(`only ${corpus.posts.length} posts left after coverage ${priorCoverage} (≤ verbose tail ${MIN_VERBOSE_IC_POSTS}) — stopping; these stay verbatim in production.`);
      reachedHead = true;
      break;
    }

    const system =
      kind === "begins"
        ? buildDefaultBeginsSystemPrompt(corpus.inputCeilingPost, { guidance })
        : buildDefaultContinuesSystemPrompt(corpus.inputCeilingPost, priorCoverage, { guidance });
    const corpusText = formatCorpusForEditor(corpus, corpus.includedPosts, true);
    const user =
      kind === "begins"
        ? `Compress the following into [STORY BEGINS]:\n\n${corpusText}`
        : `[STORY TO DATE]\n${stripStoryToDateWrapper(priorStoryToDate?.trim() || "(empty)")}\n\nNew log prose to fold in:\n\n${corpusText}`;
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];

    let committed = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !committed; attempt++) {
      let raw = await completeChat(editor, apiKey, messages, { maxTokens: editor.responseLimit });
      let block = extractStoryBlock(raw, kind);
      let coverage = extractCoverage(raw);
      let seamRetried = false;

      if (
        block &&
        coverage != null &&
        corpus.inputCeilingPost != null &&
        shouldRetrySeamGate(coverage, corpus.inputCeilingPost)
      ) {
        const retryMessages: ChatMessage[] = [
          ...messages,
          { role: "assistant", content: raw },
          { role: "user", content: buildSeamRetryUserMessage(kind, coverage, corpus.inputCeilingPost) },
        ];
        const retryRaw = await completeChat(editor, apiKey, retryMessages, { maxTokens: editor.responseLimit });
        const rb = extractStoryBlock(retryRaw, kind);
        const rc = extractCoverage(retryRaw);
        if (rb && rc != null && rc < coverage && rc <= corpus.inputCeilingPost) {
          block = rb;
          coverage = rc;
          raw = retryRaw;
          seamRetried = true;
        }
      }

      if (!block || coverage == null) {
        log(`seq ${seq} attempt ${attempt}: missing block/coverage — retrying`);
        continue;
      }
      if (corpus.inputCeilingPost != null && coverage > corpus.inputCeilingPost) {
        log(`seq ${seq} attempt ${attempt}: coverage ${coverage} > ceiling ${corpus.inputCeilingPost} — retrying`);
        continue;
      }
      const chainEntry = buildChainPostIndex(db, logbookId).find((e) => e.postNumber === coverage);
      if (!chainEntry || chainEntry.hidden) {
        log(`seq ${seq} attempt ${attempt}: coverage ${coverage} not on visible chain — retrying`);
        continue;
      }
      const coveragePost = corpus.includedPosts.find((p) => p.icPostNumber === coverage);
      if (!coveragePost) {
        log(`seq ${seq} attempt ${attempt}: coverage ${coverage} not in included input (ceiling ${corpus.inputCeilingPost}) — retrying`);
        continue;
      }
      if (priorCoverage != null && coverage <= priorCoverage) {
        log(`seq ${seq} attempt ${attempt}: coverage ${coverage} does not advance past ${priorCoverage} — retrying`);
        continue;
      }

      segments.push({ kind, content: block, coverageThroughPost: coverage, coveragePageId: coveragePost.pageId });
      metrics.push({
        seq,
        kind,
        priorCoverage,
        inputCeilingPost: corpus.inputCeilingPost,
        inputPosts: corpus.includedPosts.length,
        coverageThroughPost: coverage,
        words: words(block),
        tokens: estimateTokens(block),
        seamRetried,
        attempts: attempt,
      });
      afterPageId = coveragePost.pageId;
      priorCoverage = coverage;
      committed = true;
      log(
        `seq ${seq} ${kind}: cov ${metrics[metrics.length - 1]!.priorCoverage ?? 0}→${coverage}/${headPost} | ${words(block)}w ${estimateTokens(block)}tok | in ${corpus.includedPosts.length} posts${seamRetried ? " (seam-retry)" : ""}`
      );

      // Incremental artifact writes so a crash keeps partial results.
      writeFileSync(join(outDir, "segments.json"), JSON.stringify(segments, null, 2));
      writeFileSync(join(outDir, "story-to-date-merged.txt"), mergeStoryToDate(segments));
      writeFileSync(join(outDir, "metrics.json"), JSON.stringify(metrics, null, 2));
    }

    if (!committed) {
      log(`seq ${seq}: FAILED after ${MAX_ATTEMPTS} attempts — stopping this variant's chain.`);
      break;
    }
  }

  return { metrics, segments, reachedHead, headPost };
}

async function main(): Promise<void> {
  if (VARIANT_B_GUIDANCE === INCLUDE_EXCLUDE_GUIDANCE) {
    throw new Error("Variant B guidance is identical to baseline — the .replace() didn't match. Fix before running.");
  }
  const args = process.argv.slice(2);
  const storyId = args[0];
  if (!storyId) {
    console.error("usage: story-to-date-ab-regen.ts <storyId> [--max-blocks N] [--only A|B]");
    process.exit(1);
  }
  const maxBlocksArg = args.indexOf("--max-blocks");
  const maxBlocks = maxBlocksArg >= 0 ? Number(args[maxBlocksArg + 1]) : 60;
  const onlyArg = args.indexOf("--only");
  const only = onlyArg >= 0 ? args[onlyArg + 1]?.toUpperCase() : null;

  const globalDb = getGlobalDb();
  const story = getStory(globalDb, storyId);
  if (!story) throw new Error(`story not found: ${storyId}`);
  const db = getStoryDb(storyId);
  const logbook = getBookByType(db, "logbook");
  if (!logbook) throw new Error("no logbook");
  const editor = getAgentProfile(story.ownerUserId, "editor");

  let apiKey = process.env.FEATHERLESS_API_KEY?.trim() ?? "";
  if (!apiKey) {
    try {
      apiKey = getDecryptedFeatherlessKey(globalDb, story.ownerUserId) ?? "";
    } catch {
      apiKey = "";
    }
  }
  if (!apiKey) throw new Error("no Featherless API key (set FEATHERLESS_API_KEY or provide APP_MASTER_KEY for DB key)");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const root = join("data", "experiments", "story-to-date", `ab-${stamp}-${storyId.slice(0, 8)}`);
  mkdirSync(root, { recursive: true });
  const logFile = join(root, "progress.log");

  const ctx = { db, storyId, logbookId: logbook.id, editor, apiKey };
  const variants: { label: string; guidance: string }[] = [
    { label: "A", guidance: INCLUDE_EXCLUDE_GUIDANCE },
    { label: "B", guidance: VARIANT_B_GUIDANCE },
  ].filter((v) => !only || v.label === only);

  const results: Record<string, any> = {};
  for (const v of variants) {
    const outDir = join(root, `variant-${v.label}`);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "system-prompt-sample-continues.txt"), buildDefaultContinuesSystemPrompt(500, 450, { guidance: v.guidance }));
    console.log(`\n=== Variant ${v.label} — regenerating full chain ===`);
    const r = await runVariant(v.label, v.guidance, ctx, outDir, logFile, maxBlocks);
    const totalTokens = r.metrics.reduce((a, m) => a + m.tokens, 0);
    const totalWords = r.metrics.reduce((a, m) => a + m.words, 0);
    results[v.label] = {
      segments: r.metrics.length,
      coverageReached: r.metrics.length ? r.metrics[r.metrics.length - 1]!.coverageThroughPost : 0,
      headPost: r.headPost,
      reachedHead: r.reachedHead,
      totalWords,
      totalTokens,
      avgWordsPerCoveredPost: r.metrics.length
        ? (totalWords / (r.metrics[r.metrics.length - 1]!.coverageThroughPost || 1)).toFixed(2)
        : "0",
    };
  }

  const summary = {
    storyId,
    editorModel: editor.model,
    editorContext: editor.contextLimit,
    lengthTarget: "6 words/post target, 10 words/post cap",
    productionBaseline: { segments: 15, totalTokens: 9184, coverageReached: 737 },
    variants: results,
  };
  writeFileSync(join(root, "comparison.json"), JSON.stringify(summary, null, 2));
  console.log("\n=== COMPARISON ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nArtifacts: ${root}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
