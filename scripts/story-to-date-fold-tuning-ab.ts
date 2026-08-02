#!/usr/bin/env npx tsx
/**
 * A/B experiment: two levers for over-loose fold compression (2026-08-02, VM story 019fa8c7).
 *
 * Root cause confirmed via VM telemetry: a real fold call showed inputTokens=6379,
 * outputTokens=2169 — ~34% output/input, almost exactly FOLD_TARGET_RATIO (0.5) applied to the
 * merged segments' word count. The model is obeying the prompt; the instructed target itself
 * isn't aggressive enough for what the user wants ("5 tokens per post" historically).
 *
 * Two independent levers, tested here:
 *   - ratio: the ratio in the "aim for about N words" prompt instruction (production: 0.5)
 *   - ceiling: the API's maxTokens param (production: editor.responseLimit, e.g. 4096 -- the
 *     model's full ceiling, not tied to the instructed target at all)
 *
 * Each arm runs against the REAL current append-candidate batch (via the actual production
 * selectFoldSet/selectFoldBatch functions, so this is exactly what the next real fold job would
 * see), using the real production buildFoldSystem prompt unmodified except for the ratio.
 *
 * Usage (against the pulled VM save):
 *   $env:LOREMASTER_DATA_DIR = "data/vm-sync"
 *   npx tsx scripts/story-to-date-fold-tuning-ab.ts <storyId> [--arms a,b,c,d] [--model deepseek-ai/DeepSeek-V4-Pro]
 *
 * Requires FEATHERLESS_API_KEY env or a decryptable key in the global DB (APP_MASTER_KEY).
 * Artifacts: data/experiments/fold-tuning-ab/<stamp>/
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

try {
  process.loadEnvFile()
} catch {
  /* no .env */
}

import { getGlobalDb } from '../src/db/global-db.js'
import { getStoryDb } from '../src/db/story-db.js'
import { getStory } from '../src/db/story-store.js'
import { getBookByType } from '../src/db/book-store.js'
import { listStoryToDateSegments } from '../src/db/story-to-date-store.js'
import { getDecryptedFeatherlessKey } from '../src/db/user-store.js'
import { getAgentProfile } from '../src/services/agent-config.js'
import type { AgentProfile } from '../src/config.js'
import { completeChatWithMeta, type ChatMessage } from '../src/inference/featherless.js'
import {
  buildFoldSystem,
  selectFoldSet,
  selectFoldBatch,
  estimateTokens,
  foldWordCount,
  looksFoldDigestTruncated,
  CHARS_PER_TOKEN_ESTIMATE,
  FOLD_PROSE_CHARS_PER_WORD,
  type FoldableSegment,
} from '../src/services/story-to-date/engine.js'

interface Arm {
  label: string
  ratio: number
  /** maxTokens sent to the API. null = production default (editor.responseLimit). */
  ceilingMultiplier: number | null
}

const ALL_ARMS: Record<string, Arm> = {
  a: {
    label: 'baseline (ratio=0.5, ceiling=full responseLimit)',
    ratio: 0.5,
    ceilingMultiplier: null,
  },
  b: {
    label: 'tight ratio only (ratio=0.2, ceiling=full responseLimit)',
    ratio: 0.2,
    ceilingMultiplier: null,
  },
  c: {
    label: 'loose ratio, tight ceiling (ratio=0.5, ceiling=1.3x target)',
    ratio: 0.5,
    ceilingMultiplier: 1.3,
  },
  d: {
    label: 'both tightened (ratio=0.2, ceiling=1.3x target)',
    ratio: 0.2,
    ceilingMultiplier: 1.3,
  },
  e: {
    label: 'very tight ratio (ratio=0.1, ceiling=full responseLimit)',
    ratio: 0.1,
    ceilingMultiplier: null,
  },
}

/** Floor lowered to 100 for this experiment (production const is 200) to see whether ratio 0.1
 * actually diverges from 0.2 once the floor stops masking it. */
const EXPERIMENT_MIN_WORDS = 100

function targetWordsForRatio(mergedWords: number, responseLimit: number, ratio: number): number {
  const targetOutTokens = Math.floor(responseLimit * 0.7)
  const maxWords = Math.floor(
    (targetOutTokens * CHARS_PER_TOKEN_ESTIMATE) / FOLD_PROSE_CHARS_PER_WORD,
  )
  return Math.min(Math.max(EXPERIMENT_MIN_WORDS, Math.round(mergedWords * ratio)), maxWords)
}

function targetTokensFromWords(words: number): number {
  return Math.ceil((words * FOLD_PROSE_CHARS_PER_WORD) / CHARS_PER_TOKEN_ESTIMATE)
}

async function main() {
  const args = process.argv.slice(2)
  const storyId = args[0]
  if (!storyId || storyId.startsWith('--')) {
    console.error(
      'Usage: story-to-date-fold-tuning-ab.ts <storyId> [--arms a,b,c,d] [--model <id>]',
    )
    process.exit(1)
  }
  const armsArg = args.find((a) => a.startsWith('--arms='))?.split('=')[1] ?? 'a,b,c,d'
  const modelOverride = args.find((a) => a.startsWith('--model='))?.split('=')[1]
  const armKeys = armsArg.split(',').map((s) => s.trim())

  const globalDb = getGlobalDb()
  const story = getStory(globalDb, storyId)
  if (!story) throw new Error(`story ${storyId} not found`)
  const apiKey =
    process.env.FEATHERLESS_API_KEY ?? getDecryptedFeatherlessKey(globalDb, story.ownerUserId)
  if (!apiKey)
    throw new Error('no Featherless API key (set FEATHERLESS_API_KEY or check global DB)')

  const db = getStoryDb(storyId, { skipRecovery: true })
  const logbook = getBookByType(db, 'logbook')
  if (!logbook) throw new Error('no logbook found')

  let editor: AgentProfile = getAgentProfile(story.ownerUserId, 'editor')
  if (modelOverride)
    editor = { ...editor, model: modelOverride, fallbackModels: [], fallbackProfiles: [] }

  const rows = listStoryToDateSegments(db, logbook.id).filter((s) => s.content?.trim() && !s.broken)
  const segments: FoldableSegment[] = rows.map((s) => ({
    id: s.id,
    kind: s.kind,
    content: s.content!.trim(),
    coverageThroughIcPost: s.coverageThroughIcPost,
    coveragePageId: s.coveragePageId,
    seq: s.seq,
  }))
  const { fold: eligible } = selectFoldSet(segments)
  const appendCandidates = eligible.filter((s) => s.kind !== 'fold')
  const batch = selectFoldBatch(appendCandidates, editor.responseLimit)
  if (!batch.length) throw new Error('no append-eligible batch right now — nothing to test against')

  const merged = batch.map((s) => s.content).join('\n\n')
  const mergedTokens = estimateTokens(merged)
  const mergedWords = foldWordCount(merged)
  console.log(
    `Batch: ${batch.length} segment(s), seqs [${batch.map((s) => s.seq).join(',')}], ` +
      `merged ${mergedWords} words / ~${mergedTokens} tokens. Model: ${editor.model} (temp=${editor.temperature}, responseLimit=${editor.responseLimit})`,
  )

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = join('data', 'experiments', 'fold-tuning-ab', stamp)
  mkdirSync(outDir, { recursive: true })

  const rows2: string[] = []
  for (const key of armKeys) {
    const arm = ALL_ARMS[key]
    if (!arm) {
      console.warn(`unknown arm ${key}, skipping`)
      continue
    }
    const targetWords = targetWordsForRatio(mergedWords, editor.responseLimit, arm.ratio)
    const targetTokens = targetTokensFromWords(targetWords)
    const maxTokens = arm.ceilingMultiplier
      ? Math.min(editor.responseLimit, Math.ceil(targetTokens * arm.ceilingMultiplier))
      : editor.responseLimit

    console.log(`\n=== Arm ${key}: ${arm.label} ===`)
    console.log(`  targetWords=${targetWords} (~${targetTokens} tok), maxTokens sent=${maxTokens}`)

    const messages: ChatMessage[] = [
      { role: 'system', content: buildFoldSystem(targetWords) },
      { role: 'user', content: `Older memory to condense (chronological):\n\n${merged}` },
    ]

    const started = Date.now()
    const { content, finishReason } = await completeChatWithMeta(editor, apiKey, messages, {
      maxTokens,
      timeoutMs: 10 * 60_000,
    })
    const elapsedMs = Date.now() - started
    const digest = content.trim()
    const outTokens = estimateTokens(digest)
    const outWords = foldWordCount(digest)
    const likelyTruncated = looksFoldDigestTruncated(digest, editor.responseLimit)

    console.log(
      `  -> ${elapsedMs}ms, finishReason=${finishReason}, output ${outWords} words / ~${outTokens} tok ` +
        `(${((outTokens / mergedTokens) * 100).toFixed(1)}% of input), likelyTruncated=${likelyTruncated}`,
    )

    const digestFile = join(outDir, `arm-${key}-digest.txt`)
    writeFileSync(digestFile, digest, 'utf-8')
    rows2.push(
      JSON.stringify({
        arm: key,
        label: arm.label,
        targetWords,
        targetTokensEquivalent: targetTokens,
        maxTokensSent: maxTokens,
        finishReason,
        elapsedMs,
        outputWords: outWords,
        outputTokens: outTokens,
        compressionPct: Math.round((outTokens / mergedTokens) * 1000) / 10,
        likelyTruncated,
        digestFile,
      }),
    )
  }

  writeFileSync(join(outDir, 'summary.jsonl'), rows2.join('\n') + '\n', 'utf-8')
  console.log(`\nArtifacts: ${outDir}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
