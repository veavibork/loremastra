#!/usr/bin/env npx tsx
/**
 * A/B: batch compression (shipped) vs next-scene-only continues.
 * Seeds from production [STORY BEGINS] so we only regenerate the continues chain
 * where live failures occurred (seq 29+ on the main story).
 *
 * Usage:
 *   LOREMASTER_DATA_DIR=data/vm-sync npx tsx scripts/story-to-date-seam-ab-regen.ts <storyId> [--only A|B] [--max-blocks N]
 */
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
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
import { getDecryptedFeatherlessKey } from '../src/db/user-store.js'
import { getAgentProfile } from '../src/services/agent-config.js'
import { completeChat, type ChatMessage } from '../src/inference/featherless.js'
import {
  INCLUDE_EXCLUDE_GUIDANCE,
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
} from '../src/services/story-to-date/engine.js'
import { buildChainPostIndex } from '../src/services/post-index.js'

const INPUT_CUTOFF = 0.8
const MAX_ATTEMPTS = 2
const EDITOR_TIMEOUT_MS = 10 * 60_000
const STORY_ID_DEFAULT = '019f25e0-219c-7189-b481-9f389a9a3c39'

const NEXT_SCENE_CEILING_INSTRUCTION = (inputCeilingPost: number | null) =>
  inputCeilingPost == null
    ? 'End coverage at the first complete scene seam in the new log — not at the end of the input.'
    : `The input includes posts through ${inputCeilingPost}, but you must NOT try to cover them all. Stop at the FIRST complete scene seam after prior coverage — even if dozens of posts remain. Treat ${inputCeilingPost} as an upper bound only, not a target.`

const NEXT_SCENE_LENGTH = `Length: one scene only — typically 80–200 words (one or two paragraphs). Do not scale length to how many posts remain in the input; quiet scenes stay short.`

const NEXT_SCENE_CONTINUES_ADDENDUM = `SCOPE: Summarize only the next scene — the first self-contained beat after prior coverage ends. Do not batch multiple scenes. Do not re-state the closing beat already in [STORY TO DATE]; open on the first new consequential state change. Never echo bracket labels like [STORY CONTINUES] inside the prose.`

function buildNextSceneContinuesPrompt(
  inputCeilingPost: number | null,
  priorCoveragePost: number | null,
): string {
  const base = buildDefaultContinuesSystemPrompt(inputCeilingPost, priorCoveragePost, {
    guidance: INCLUDE_EXCLUDE_GUIDANCE,
  })
  return base
    .replace(
      /Length: this block covers roughly[\s\S]*?length is earned by consequence, not by drama\./,
      NEXT_SCENE_LENGTH,
    )
    .replace(
      /The supplied log is complete through post[\s\S]*?continue after your coverage\./,
      NEXT_SCENE_CEILING_INSTRUCTION(inputCeilingPost),
    )
    .replace(
      'Do not re-introduce events already in [STORY TO DATE] — extend the causal spine only.',
      'Do not re-introduce events already in [STORY TO DATE] — extend the causal spine only.\n\n' +
        NEXT_SCENE_CONTINUES_ADDENDUM,
    )
}

interface BlockMetric {
  seq: number
  kind: StoryBlockKind
  priorCoverage: number | null
  inputCeilingPost: number | null
  inputPosts: number
  coverageThroughPost: number
  coverageDelta: number | null
  words: number
  tokens: number
  overlapWithPrior: number | null
  markerLeak: boolean
  duplicateRejected: boolean
  seamRetried: boolean
  attempts: number
}

function wordList(s: string): string[] {
  return s.trim().split(/\s+/).filter(Boolean)
}

function wordCount(s: string): number {
  return wordList(s).length
}

function overlapRatio(a: string, b: string): number {
  const aw = wordList(a)
  const setB = new Set(wordList(b).map((w) => w.toLowerCase()))
  const shared = aw.filter((w) => setB.has(w.toLowerCase())).length
  return aw.length ? shared / aw.length : 0
}

function sanitizeBlock(text: string): string {
  return text
    .replace(/\s*\[\/STORY (?:BEGINS|CONTINUES)\]\s*/gi, ' ')
    .replace(/\s*\[STORY (?:BEGINS|CONTINUES|TO DATE|ENDS)\]\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function hasMarkerLeak(text: string): boolean {
  return /\[STORY (?:BEGINS|CONTINUES|TO DATE|ENDS)\]/i.test(text)
}

function loadProductionBeginsSeed(db: any, _logbookId: string): StoryToDateSegment | null {
  const row = db
    .prepare(
      `SELECT kind, content, coverage_through_ic_post, coverage_page_id
       FROM story_to_date_segment
       WHERE broken = 0 AND kind = 'begins' AND content IS NOT NULL AND trim(content) != ''
       ORDER BY seq LIMIT 1`,
    )
    .get()
  if (!row?.content || row.coverage_through_ic_post == null) return null
  return {
    kind: 'begins',
    content: row.content.trim(),
    coverageThroughPost: row.coverage_through_ic_post,
    coveragePageId: row.coverage_page_id ?? null,
  }
}

interface VariantConfig {
  label: string
  buildContinuesPrompt: (ceiling: number | null, prior: number | null) => string
  rejectDuplicates: boolean
  sanitize: boolean
}

const VARIANTS: VariantConfig[] = [
  {
    label: 'A',
    buildContinuesPrompt: (ceiling, prior) =>
      buildDefaultContinuesSystemPrompt(ceiling, prior, { guidance: INCLUDE_EXCLUDE_GUIDANCE }),
    rejectDuplicates: false,
    sanitize: false,
  },
  {
    label: 'B',
    buildContinuesPrompt: (ceiling, prior) => buildNextSceneContinuesPrompt(ceiling, prior),
    rejectDuplicates: true,
    sanitize: true,
  },
]

async function runVariant(
  cfg: VariantConfig,
  ctx: {
    db: any
    storyId: string
    logbookId: string
    editor: any
    apiKey: string
    seed: StoryToDateSegment
  },
  outDir: string,
  logFile: string,
  maxBlocks: number,
): Promise<{
  metrics: BlockMetric[]
  segments: StoryToDateSegment[]
  reachedHead: boolean
  headPost: number
}> {
  const { db, storyId, logbookId, editor, apiKey, seed } = ctx
  const log = (m: string) => {
    console.log(`[${cfg.label}] ${m}`)
    appendFileSync(logFile, `[${cfg.label}] ${m}\n`)
  }

  const chain = buildChainPostIndex(db, logbookId)
  const headPost = chain.length ? chain[chain.length - 1]!.postNumber : 0

  const segments: StoryToDateSegment[] = [seed]
  const metrics: BlockMetric[] = []
  let afterPageId: string | null = seed.coveragePageId
  let priorCoverage: number = seed.coverageThroughPost

  for (let seq = 1; seq < maxBlocks; seq++) {
    const kind: StoryBlockKind = 'continues'
    const priorStoryToDate = mergeStoryToDate(segments)

    const corpus = buildStoryCorpus(db, storyId, logbookId, {
      contextLimit: editor.contextLimit,
      responseLimit: editor.responseLimit,
      inputCutoff: INPUT_CUTOFF,
      afterPageId,
      priorStoryToDate,
    })

    if (corpus.includedPosts.length === 0) {
      log(`no posts left after coverage ${priorCoverage} — reached head.`)
      return { metrics, segments, reachedHead: true, headPost }
    }
    if (corpus.posts.length <= MIN_VERBOSE_IC_POSTS) {
      log(
        `only ${corpus.posts.length} posts remain (≤ verbose tail ${MIN_VERBOSE_IC_POSTS}) — stopping.`,
      )
      return { metrics, segments, reachedHead: true, headPost }
    }

    const system = cfg.buildContinuesPrompt(corpus.inputCeilingPost, priorCoverage)
    const corpusText = formatCorpusForEditor(corpus, corpus.includedPosts, true)
    const user = `[STORY TO DATE]\n${stripStoryToDateWrapper(priorStoryToDate.trim())}\n\nNew log prose to fold in:\n\n${corpusText}`
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]

    let committed = false
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !committed; attempt++) {
      let raw = await completeChat(editor, apiKey, messages, {
        maxTokens: editor.responseLimit,
        timeoutMs: EDITOR_TIMEOUT_MS,
      })
      let block = extractStoryBlock(raw, kind)
      let coverage = extractCoverage(raw)
      let seamRetried = false
      let duplicateRejected = false

      if (
        block &&
        coverage != null &&
        corpus.inputCeilingPost != null &&
        shouldRetrySeamGate(coverage, corpus.inputCeilingPost)
      ) {
        const retryMessages: ChatMessage[] = [
          ...messages,
          { role: 'assistant', content: raw },
          {
            role: 'user',
            content: buildSeamRetryUserMessage(kind, coverage, corpus.inputCeilingPost),
          },
        ]
        const retryRaw = await completeChat(editor, apiKey, retryMessages, {
          maxTokens: editor.responseLimit,
          timeoutMs: EDITOR_TIMEOUT_MS,
        })
        const rb = extractStoryBlock(retryRaw, kind)
        const rc = extractCoverage(retryRaw)
        if (rb && rc != null && rc < coverage && rc <= corpus.inputCeilingPost) {
          block = rb
          coverage = rc
          raw = retryRaw
          seamRetried = true
        }
      }

      if (!block || coverage == null) {
        log(`seq ${seq} attempt ${attempt}: missing block/coverage`)
        continue
      }

      if (cfg.sanitize) block = sanitizeBlock(block)

      const priorBlock = segments[segments.length - 1]!.content
      const overlap = overlapRatio(block, priorBlock)
      if (cfg.rejectDuplicates && overlap >= 0.85) {
        duplicateRejected = true
        log(
          `seq ${seq} attempt ${attempt}: duplicate of prior (${(overlap * 100).toFixed(1)}% overlap) — retrying`,
        )
        continue
      }

      if (corpus.inputCeilingPost != null && coverage > corpus.inputCeilingPost) continue
      const chainEntry = buildChainPostIndex(db, logbookId).find((e) => e.postNumber === coverage)
      if (!chainEntry || chainEntry.hidden) continue
      const coveragePost = corpus.includedPosts.find((p) => p.icPostNumber === coverage)
      if (!coveragePost) continue
      if (coverage <= priorCoverage) continue

      const metric: BlockMetric = {
        seq,
        kind,
        priorCoverage,
        inputCeilingPost: corpus.inputCeilingPost,
        inputPosts: corpus.includedPosts.length,
        coverageThroughPost: coverage,
        coverageDelta: coverage - priorCoverage,
        words: wordCount(block),
        tokens: estimateTokens(block),
        overlapWithPrior: overlap,
        markerLeak: hasMarkerLeak(block),
        duplicateRejected,
        seamRetried,
        attempts: attempt,
      }
      metrics.push(metric)
      segments.push({
        kind,
        content: block,
        coverageThroughPost: coverage,
        coveragePageId: coveragePost.pageId,
      })
      afterPageId = coveragePost.pageId
      priorCoverage = coverage
      committed = true
      log(
        `seq ${seq}: cov ${metric.priorCoverage}→${coverage}/${headPost} (+${metric.coverageDelta}) | ${metric.words}w | in ${corpus.includedPosts.length} posts | overlap ${(overlap * 100).toFixed(1)}%${seamRetried ? ' seam-retry' : ''}${metric.markerLeak ? ' LEAK' : ''}`,
      )

      writeFileSync(join(outDir, 'segments.json'), JSON.stringify(segments, null, 2))
      writeFileSync(join(outDir, 'story-to-date-merged.txt'), mergeStoryToDate(segments))
      writeFileSync(join(outDir, 'metrics.json'), JSON.stringify(metrics, null, 2))
    }

    if (!committed) {
      log(`seq ${seq}: FAILED after ${MAX_ATTEMPTS} attempts — stopping.`)
      break
    }
  }

  return { metrics, segments, reachedHead: false, headPost }
}

function summarizeVariant(metrics: BlockMetric[], headPost: number, reachedHead: boolean) {
  const continues = metrics.filter((m) => m.kind === 'continues')
  const dupes = continues.filter((m) => (m.overlapWithPrior ?? 0) >= 0.85).length
  const leaks = continues.filter((m) => m.markerLeak).length
  const avgDelta = continues.length
    ? continues.reduce((a, m) => a + (m.coverageDelta ?? 0), 0) / continues.length
    : 0
  const avgWords = continues.length
    ? continues.reduce((a, m) => a + m.words, 0) / continues.length
    : 0
  const lastCov = continues.length ? continues[continues.length - 1]!.coverageThroughPost : 0
  return {
    continuesBlocks: continues.length,
    coverageReached: lastCov,
    headPost,
    reachedHead,
    duplicateBlocks: dupes,
    markerLeaks: leaks,
    avgCoverageDelta: Number(avgDelta.toFixed(1)),
    avgWordsPerBlock: Number(avgWords.toFixed(0)),
    totalWords: continues.reduce((a, m) => a + m.words, 0),
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const storyId = args[0] ?? STORY_ID_DEFAULT
  const maxBlocksArg = args.indexOf('--max-blocks')
  const maxBlocks = maxBlocksArg >= 0 ? Number(args[maxBlocksArg + 1]) : 50
  const onlyArg = args.indexOf('--only')
  const only = onlyArg >= 0 ? args[onlyArg + 1]?.toUpperCase() : null

  const globalDb = getGlobalDb()
  const story = getStory(globalDb, storyId)
  if (!story) throw new Error(`story not found: ${storyId}`)
  const db = getStoryDb(storyId)
  const logbook = getBookByType(db, 'logbook')
  if (!logbook) throw new Error('no logbook')
  const editor = getAgentProfile(story.ownerUserId, 'editor')

  let apiKey = process.env.FEATHERLESS_API_KEY?.trim() ?? ''
  if (!apiKey) {
    try {
      apiKey = getDecryptedFeatherlessKey(globalDb, story.ownerUserId) ?? ''
    } catch {
      apiKey = ''
    }
  }
  if (!apiKey) throw new Error('no Featherless API key')

  const seed = loadProductionBeginsSeed(db, logbook.id)
  if (!seed) throw new Error('no production begins seed in story DB')

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(
    'data',
    'experiments',
    'story-to-date',
    `seam-ab-${stamp}-${storyId.slice(0, 8)}`,
  )
  mkdirSync(root, { recursive: true })
  const logFile = join(root, 'progress.log')

  writeFileSync(
    join(root, 'production-baseline.json'),
    JSON.stringify(
      db
        .prepare(
          `SELECT seq, kind, coverage_through_ic_post, length(content) as chars, content
           FROM story_to_date_segment WHERE broken = 0 ORDER BY seq`,
        )
        .all(),
      null,
      2,
    ),
  )

  writeFileSync(join(root, 'seed-begins.txt'), seed.content)
  writeFileSync(
    join(root, 'variant-B-continues-prompt-sample.txt'),
    buildNextSceneContinuesPrompt(1517, 1487),
  )

  const ctx = { db, storyId, logbookId: logbook.id, editor, apiKey, seed }
  const results: Record<string, ReturnType<typeof summarizeVariant>> = {}

  for (const v of VARIANTS.filter((x) => !only || x.label === only)) {
    const outDir = join(root, `variant-${v.label}`)
    mkdirSync(outDir, { recursive: true })
    console.log(
      `\n=== Variant ${v.label} (${v.label === 'A' ? 'shipped batch' : 'next-scene-only'}) ===`,
    )
    const r = await runVariant(v, ctx, outDir, logFile, maxBlocks)
    results[v.label] = summarizeVariant(r.metrics, r.headPost, r.reachedHead)
  }

  const comparison = {
    storyId,
    seedCoverage: seed.coverageThroughPost,
    editorModel: editor.model,
    productionIssues: {
      seq29seq30Identical: true,
      seq35seq36Bleed: 'career-counseling porch meeting covered twice',
      seq39ContextDrop: 'Iowa comment / crack joke without ER aftermath bridge',
      markerLeaks: 'seq 31,32,33,38',
    },
    variants: results,
  }
  writeFileSync(join(root, 'comparison.json'), JSON.stringify(comparison, null, 2))
  console.log('\n=== COMPARISON ===')
  console.log(JSON.stringify(comparison, null, 2))
  console.log(`\nArtifacts: ${root}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
