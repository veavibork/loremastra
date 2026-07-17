#!/usr/bin/env npx tsx
/**
 * A/B experiment: does a model-judged coverage-verification pass improve story-to-date
 * continues segments?
 *
 * Arm A (control): production flow — bounded window, next-scene prompt, seam + sprint gates
 *   (mirrors src/services/story-to-date/worker.ts without DB writes).
 * Arm B (verify):  same flow + an in-loop judge that checks the block accounts for every
 *   consequential event in its claimed coverage window; on fail, one rewrite with the judge's
 *   missing-events feedback.
 *
 * Both arms' FINAL outputs are scored by the same judge, so pass-rate/missing-count compare
 * fairly. Read-only against the story DB (skipRecovery, no writes).
 *
 * Usage (against the pulled VM save):
 *   $env:LOREMASTER_DATA_DIR = "data/vm-sync"
 *   npx tsx scripts/story-to-date-verify-ab.ts <storyId> [--trials 3] [--after 0,1] [--arms A,B]
 *
 * Requires FEATHERLESS_API_KEY env or a decryptable key in the global DB (APP_MASTER_KEY).
 * Artifacts: data/experiments/verify-ab/<stamp>/
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
import { completeChat, type ChatMessage } from '../src/inference/featherless.js'
import { STORY_TO_DATE_INPUT_CUTOFF } from '../src/services/story-to-date/index.js'
import {
  buildCoverageSprintRetryUserMessage,
  buildNextSceneContinuesSystemPrompt,
  buildSeamRetryUserMessage,
  buildStoryCorpus,
  extractCoverage,
  extractStoryBlock,
  formatCorpusForEditor,
  hasLeakedStoryMarkers,
  looksNextSceneCoverageSprint,
  mergeStoryToDate,
  NEXT_SCENE_INPUT_WINDOW_POSTS,
  sanitizeStoryBlockContent,
  shouldRetrySeamGate,
  STORY_BLOCK_DUPLICATE_OVERLAP_THRESHOLD,
  storyBlockWordCount,
  storyBlockWordOverlapRatio,
  stripStoryToDateWrapper,
  type StoryCorpus,
  type StoryToDateSegment,
  type VerbosePost,
} from '../src/services/story-to-date/engine.js'

const CALL_TIMEOUT_MS = 5 * 60_000
const MAX_ATTEMPTS = 2

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

const args = process.argv.slice(2)
const storyId = args[0]
if (!storyId || storyId.startsWith('--')) {
  console.error(
    'Usage: npx tsx scripts/story-to-date-verify-ab.ts <storyId> [--trials 3] [--after 0,1] [--arms A,B]',
  )
  process.exit(1)
}
const trials = Number(argValue(args, '--trials') ?? 3)
const afterSeqs = (argValue(args, '--after') ?? '0,1').split(',').map((s) => Number(s.trim()))
const arms = (argValue(args, '--arms') ?? 'A,B').split(',').map((s) => s.trim()) as ('A' | 'B')[]
/** Override the Editor model (e.g. --model deepseek-ai/DeepSeek-V4-Flash) without touching DB config. */
const modelOverride = argValue(args, '--model')

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const globalDb = getGlobalDb()
const story = getStory(globalDb, storyId)
if (!story) throw new Error(`story not found: ${storyId}`)
const db = getStoryDb(storyId, { skipRecovery: true })
const logbook = getBookByType(db, 'logbook')
if (!logbook) throw new Error('story has no logbook')
const baseEditor = getAgentProfile(story.ownerUserId, 'editor')
const editor: AgentProfile = modelOverride ? { ...baseEditor, model: modelOverride } : baseEditor
const apiKey =
  process.env.FEATHERLESS_API_KEY?.trim() ||
  getDecryptedFeatherlessKey(globalDb, story.ownerUserId) ||
  ''
if (!apiKey) throw new Error('no Featherless API key (env or DB)')

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const rootDir = join('data', 'experiments', 'verify-ab', stamp)
mkdirSync(rootDir, { recursive: true })

// ---------------------------------------------------------------------------
// Production-parity generation (mirrors worker.ts, no DB writes)
// ---------------------------------------------------------------------------

interface Candidate {
  raw: string
  block: string
  coverageThroughPost: number
}

function parseResponse(raw: string): Candidate | null {
  const block = extractStoryBlock(raw, 'continues')
  const coverageThroughPost = extractCoverage(raw)
  if (!block || coverageThroughPost == null) return null
  return { raw, block, coverageThroughPost }
}

interface GenOutcome {
  candidate: Candidate | null
  failReason: string | null
  calls: number
  gateRetries: number
  messages: ChatMessage[]
  /** Raw responses from attempts that failed to parse or validate — kept for diagnosis. */
  failedRaws: string[]
}

function validateCandidate(
  candidate: Candidate,
  corpus: StoryCorpus,
  priorCoverage: number,
  priorBlock: string,
): string | null {
  if (!candidate.block) return 'empty block after sanitization'
  if (hasLeakedStoryMarkers(candidate.block)) return 'leaked story markers'
  const overlap = storyBlockWordOverlapRatio(candidate.block, priorBlock)
  if (overlap >= STORY_BLOCK_DUPLICATE_OVERLAP_THRESHOLD)
    return `duplicates prior segment (${(overlap * 100).toFixed(0)}% overlap)`
  if (corpus.inputCeilingPost != null && candidate.coverageThroughPost > corpus.inputCeilingPost)
    return `coverage ${candidate.coverageThroughPost} exceeds ceiling ${corpus.inputCeilingPost}`
  if (!corpus.includedPosts.some((p) => p.icPostNumber === candidate.coverageThroughPost))
    return `coverage post ${candidate.coverageThroughPost} not in input`
  if (candidate.coverageThroughPost <= priorCoverage)
    return `coverage must advance beyond ${priorCoverage}`
  const delta = candidate.coverageThroughPost - priorCoverage
  if (looksNextSceneCoverageSprint(candidate.block, delta))
    return `coverage sprint: +${delta} posts in ${storyBlockWordCount(candidate.block)} words`
  return null
}

async function generateCandidate(
  corpus: StoryCorpus,
  priorSegments: StoryToDateSegment[],
  priorStoryToDate: string,
): Promise<GenOutcome> {
  const priorCoverage = priorSegments[priorSegments.length - 1]!.coverageThroughPost
  const priorBlock = priorSegments[priorSegments.length - 1]!.content
  const system = buildNextSceneContinuesSystemPrompt(corpus.inputCeilingPost, priorCoverage)
  const user = `[STORY TO DATE]\n${stripStoryToDateWrapper(priorStoryToDate)}\n\nNew log prose to fold in:\n\n${formatCorpusForEditor(corpus, corpus.includedPosts, true)}`
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]

  let calls = 0
  let gateRetries = 0
  let lastError = 'unknown'
  const failedRaws: string[] = []

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Mirror worker.ts: a thrown call (idle timeout, transient 5xx) consumes an attempt
    // instead of aborting the trial outright.
    let raw: string
    try {
      raw = await completeChat(editor, apiKey, messages, {
        maxTokens: editor.responseLimit,
        timeoutMs: CALL_TIMEOUT_MS,
      })
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      calls++
      continue
    }
    calls++
    let candidate = parseResponse(raw)

    if (
      candidate &&
      corpus.inputCeilingPost != null &&
      shouldRetrySeamGate(candidate.coverageThroughPost, corpus.inputCeilingPost)
    ) {
      gateRetries++
      const retryRaw = await completeChat(
        editor,
        apiKey,
        [
          ...messages,
          { role: 'assistant', content: raw },
          {
            role: 'user',
            content: buildSeamRetryUserMessage(
              'continues',
              candidate.coverageThroughPost,
              corpus.inputCeilingPost,
            ),
          },
        ],
        { maxTokens: editor.responseLimit, timeoutMs: CALL_TIMEOUT_MS },
      )
      calls++
      const retryParsed = parseResponse(retryRaw)
      if (
        retryParsed &&
        retryParsed.coverageThroughPost < candidate.coverageThroughPost &&
        retryParsed.coverageThroughPost <= corpus.inputCeilingPost
      ) {
        candidate = retryParsed
        raw = retryRaw
      }
    }

    if (candidate) {
      const delta = candidate.coverageThroughPost - priorCoverage
      if (looksNextSceneCoverageSprint(candidate.block, delta)) {
        gateRetries++
        const sprintRaw = await completeChat(
          editor,
          apiKey,
          [
            ...messages,
            { role: 'assistant', content: raw },
            {
              role: 'user',
              content: buildCoverageSprintRetryUserMessage(
                'continues',
                candidate.coverageThroughPost,
                priorCoverage,
              ),
            },
          ],
          { maxTokens: editor.responseLimit, timeoutMs: CALL_TIMEOUT_MS },
        )
        calls++
        const sprintParsed = parseResponse(sprintRaw)
        if (sprintParsed) {
          const sprintBlock = sanitizeStoryBlockContent(sprintParsed.block)
          const sprintDelta = sprintParsed.coverageThroughPost - priorCoverage
          if (
            sprintBlock &&
            sprintParsed.coverageThroughPost < candidate.coverageThroughPost &&
            !looksNextSceneCoverageSprint(sprintBlock, sprintDelta)
          ) {
            candidate = { ...sprintParsed, block: sprintBlock }
            raw = sprintRaw
          }
        }
      }
    }

    if (!candidate) {
      lastError = 'missing block or coverage'
      failedRaws.push(raw)
      continue
    }
    candidate = { ...candidate, block: sanitizeStoryBlockContent(candidate.block) }
    const invalid = validateCandidate(candidate, corpus, priorCoverage, priorBlock)
    if (invalid) {
      lastError = invalid
      failedRaws.push(raw)
      continue
    }
    return { candidate, failReason: null, calls, gateRetries, messages, failedRaws }
  }
  return { candidate: null, failReason: lastError, calls, gateRetries, messages, failedRaws }
}

// ---------------------------------------------------------------------------
// Judge
// ---------------------------------------------------------------------------

interface JudgeResult {
  verdict: 'pass' | 'fail'
  missing: string[]
  raw: string
}

function buildJudgeMessages(
  block: string,
  posts: VerbosePost[],
  fromPost: number,
  toPost: number,
): ChatMessage[] {
  const system = `You audit a roleplay memory system. You receive a [STORY CONTINUES] memory block and the verbatim log posts it claims to cover (posts ${fromPost} through ${toPost}). The block's job is to record what future scenes and NPCs must remember from THESE posts.

A consequential event is one a later scene could contradict if it were forgotten: state changes and decisions with consequences; relationship shifts (including new forms of address or pet names); promises and commitments; secrets revealed; injuries, deaths, and standing threats; plans agreed on. Scene staging, color, and blow-by-blow choreography are NOT consequential.

Check each consequential event in the posts against the block. Paraphrase counts as covered — exact wording is not required. Do not penalize compression; penalize absence.

Output EXACTLY this format and nothing else:
[MISSING]
- <one line per consequential event absent from the block, citing the post number — leave the section empty if nothing is missing>
[/MISSING]
[VERDICT]pass[/VERDICT] if nothing consequential is missing, otherwise [VERDICT]fail[/VERDICT]`

  const postsText = posts
    .map((p) => `--- post ${p.icPostNumber} (${p.role}) ---\n${p.content}`)
    .join('\n\n')
  const user = `Memory block to audit:\n\n[STORY CONTINUES]\n${block}\n[/STORY CONTINUES]\n\nPosts ${fromPost}–${toPost} it claims to cover:\n\n${postsText}`
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

function parseJudge(raw: string): JudgeResult | null {
  const verdictMatch = /\[VERDICT\](pass|fail)\[\/VERDICT\]/i.exec(raw)
  if (!verdictMatch) return null
  const missingMatch = /\[MISSING\]([\s\S]*?)\[\/MISSING\]/i.exec(raw)
  const missing = (missingMatch?.[1] ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('-') && l.length > 2)
  return { verdict: verdictMatch[1]!.toLowerCase() as 'pass' | 'fail', missing, raw }
}

async function judgeBlock(
  block: string,
  corpus: StoryCorpus,
  priorCoverage: number,
  coverage: number,
): Promise<JudgeResult | null> {
  const posts = corpus.includedPosts.filter(
    (p) => p.icPostNumber > priorCoverage && p.icPostNumber <= coverage,
  )
  const raw = await completeChat(
    editor,
    apiKey,
    buildJudgeMessages(block, posts, priorCoverage + 1, coverage),
    { maxTokens: editor.responseLimit, timeoutMs: CALL_TIMEOUT_MS },
  )
  return parseJudge(raw)
}

function buildRewriteMessage(missing: string[], fromPost: number, toPost: number): string {
  return `An audit found your [STORY CONTINUES] omits consequential events that occur within its claimed coverage (posts ${fromPost}–${toPost}):

${missing.join('\n')}

Rewrite [STORY CONTINUES] so future scenes retain these — telling-only memory register, compressed, no verbatim dialogue. If an omitted event belongs to a scene you deliberately did not cover, roll [COVERAGE] back to before that scene instead. Same rules and output format as before: [STORY CONTINUES]…[/STORY CONTINUES] then [COVERAGE]N[/COVERAGE].`
}

// ---------------------------------------------------------------------------
// Trial runner
// ---------------------------------------------------------------------------

interface TrialRow {
  scenario: string
  arm: 'A' | 'B'
  trial: number
  ok: boolean
  failReason?: string
  coverage?: number
  delta?: number
  words?: number
  gateRetries: number
  rewriteUsed?: boolean
  verdict?: 'pass' | 'fail'
  missingCount?: number
  calls: number
  durationMs: number
}

const rows: TrialRow[] = []

async function runTrial(
  scenario: string,
  arm: 'A' | 'B',
  trial: number,
  corpus: StoryCorpus,
  priorSegments: StoryToDateSegment[],
  priorStoryToDate: string,
): Promise<void> {
  const t0 = Date.now()
  const dir = join(rootDir, `${scenario}-${arm}-t${trial}`)
  mkdirSync(dir, { recursive: true })
  const priorCoverage = priorSegments[priorSegments.length - 1]!.coverageThroughPost

  const gen = await generateCandidate(corpus, priorSegments, priorStoryToDate)
  let calls = gen.calls
  if (!gen.candidate) {
    rows.push({
      scenario,
      arm,
      trial,
      ok: false,
      failReason: gen.failReason ?? 'unknown',
      gateRetries: gen.gateRetries,
      calls,
      durationMs: Date.now() - t0,
    })
    writeFileSync(join(dir, 'FAILED.txt'), gen.failReason ?? 'unknown')
    gen.failedRaws.forEach((r, i) => writeFileSync(join(dir, `failed-raw-${i + 1}.txt`), r))
    console.log(`  ${scenario} ${arm} t${trial}: GENERATION FAILED (${gen.failReason})`)
    return
  }

  let final = gen.candidate
  writeFileSync(join(dir, 'gen-raw.txt'), final.raw)
  let judge = await judgeBlock(final.block, corpus, priorCoverage, final.coverageThroughPost)
  calls++
  if (judge) writeFileSync(join(dir, 'judge-1.txt'), judge.raw)
  let rewriteUsed = false

  if (arm === 'B' && judge && judge.verdict === 'fail' && judge.missing.length) {
    const rewriteRaw = await completeChat(
      editor,
      apiKey,
      [
        ...gen.messages,
        { role: 'assistant', content: final.raw },
        {
          role: 'user',
          content: buildRewriteMessage(judge.missing, priorCoverage + 1, final.coverageThroughPost),
        },
      ],
      { maxTokens: editor.responseLimit, timeoutMs: CALL_TIMEOUT_MS },
    )
    calls++
    writeFileSync(join(dir, 'rewrite-raw.txt'), rewriteRaw)
    const parsed = parseResponse(rewriteRaw)
    if (parsed) {
      const rewrite = { ...parsed, block: sanitizeStoryBlockContent(parsed.block) }
      const priorBlock = priorSegments[priorSegments.length - 1]!.content
      const invalid = validateCandidate(rewrite, corpus, priorCoverage, priorBlock)
      if (!invalid) {
        const judge2 = await judgeBlock(
          rewrite.block,
          corpus,
          priorCoverage,
          rewrite.coverageThroughPost,
        )
        calls++
        if (judge2) {
          writeFileSync(join(dir, 'judge-2.txt'), judge2.raw)
          const improved =
            (judge2.verdict === 'pass' && judge.verdict === 'fail') ||
            judge2.missing.length < judge.missing.length
          if (improved) {
            final = rewrite
            judge = judge2
            rewriteUsed = true
          }
        }
      } else {
        writeFileSync(join(dir, 'rewrite-invalid.txt'), invalid)
      }
    }
  }

  writeFileSync(join(dir, 'final-block.txt'), final.block)
  const row: TrialRow = {
    scenario,
    arm,
    trial,
    ok: true,
    coverage: final.coverageThroughPost,
    delta: final.coverageThroughPost - priorCoverage,
    words: storyBlockWordCount(final.block),
    gateRetries: gen.gateRetries,
    rewriteUsed,
    verdict: judge?.verdict,
    missingCount: judge?.missing.length,
    calls,
    durationMs: Date.now() - t0,
  }
  rows.push(row)
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(row, null, 2))
  console.log(
    `  ${scenario} ${arm} t${trial}: cov ${row.coverage} (+${row.delta}), ${row.words}w, ` +
      `judge=${row.verdict}${row.missingCount ? ` (${row.missingCount} missing)` : ''}` +
      `${rewriteUsed ? ' [rewritten]' : ''}, ${calls} calls, ${Math.round(row.durationMs / 1000)}s`,
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const allSegments = listStoryToDateSegments(db, logbook!.id)
    .filter((s) => s.content?.trim() && !s.broken)
    .sort((a, b) => a.seq - b.seq)

  console.log(
    `verify-ab: story ${storyId}, editor ${editor.model}, window ${NEXT_SCENE_INPUT_WINDOW_POSTS}, ` +
      `trials ${trials}, scenarios after-seq [${afterSeqs.join(', ')}], arms [${arms.join(', ')}]`,
  )
  console.log(`artifacts: ${rootDir}\n`)

  for (const afterSeq of afterSeqs) {
    const priorRows = allSegments.filter((s) => s.seq <= afterSeq)
    const last = priorRows[priorRows.length - 1]
    if (!last || last.seq !== afterSeq || !last.coveragePageId) {
      console.warn(`scenario after-seg${afterSeq}: no filled segment at seq ${afterSeq} — skipped`)
      continue
    }
    const priorSegments: StoryToDateSegment[] = priorRows.map((s) => ({
      kind: s.kind,
      content: s.content!.trim(),
      coverageThroughPost: s.coverageThroughIcPost ?? 0,
      coveragePageId: s.coveragePageId,
    }))
    const priorStoryToDate = mergeStoryToDate(priorSegments)
    const corpus = buildStoryCorpus(db, storyId!, logbook!.id, {
      contextLimit: editor.contextLimit,
      responseLimit: editor.responseLimit,
      inputCutoff: STORY_TO_DATE_INPUT_CUTOFF,
      afterPageId: last.coveragePageId,
      priorStoryToDate,
      maxIncludedPosts: NEXT_SCENE_INPUT_WINDOW_POSTS,
    })
    const scenario = `after-seg${afterSeq}`
    console.log(
      `${scenario}: prior coverage ${last.coverageThroughIcPost}, window posts ` +
        `${corpus.includedPosts[0]?.icPostNumber}–${corpus.inputCeilingPost} (${corpus.includedPosts.length} posts)`,
    )

    for (let trial = 1; trial <= trials; trial++) {
      for (const arm of arms) {
        // A single hung/timed-out upstream call must not kill the whole experiment — record
        // the trial as failed and keep going (Featherless free tier stalls sporadically).
        try {
          await runTrial(scenario, arm, trial, corpus, priorSegments, priorStoryToDate)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          rows.push({
            scenario,
            arm,
            trial,
            ok: false,
            failReason: `call error: ${msg}`,
            gateRetries: 0,
            calls: 0,
            durationMs: 0,
          })
          console.log(`  ${scenario} ${arm} t${trial}: CALL ERROR (${msg})`)
        }
      }
    }
  }

  // Summary
  const summary: Record<string, unknown>[] = []
  for (const scenario of [...new Set(rows.map((r) => r.scenario))]) {
    for (const arm of arms) {
      const armRows = rows.filter((r) => r.scenario === scenario && r.arm === arm && r.ok)
      const failures = rows.filter((r) => r.scenario === scenario && r.arm === arm && !r.ok).length
      const passes = armRows.filter((r) => r.verdict === 'pass').length
      const avg = (xs: number[]) =>
        xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null
      summary.push({
        scenario,
        arm,
        trials: armRows.length,
        genFailures: failures,
        judgePassRate: armRows.length ? `${passes}/${armRows.length}` : '-',
        avgMissing: avg(armRows.map((r) => r.missingCount ?? 0)),
        avgDelta: avg(armRows.map((r) => r.delta ?? 0)),
        avgWords: avg(armRows.map((r) => r.words ?? 0)),
        avgCalls: avg(armRows.map((r) => r.calls)),
        rewritesUsed: armRows.filter((r) => r.rewriteUsed).length,
      })
    }
  }
  console.log('\n=== SUMMARY ===')
  console.table(summary)
  writeFileSync(join(rootDir, 'rows.json'), JSON.stringify(rows, null, 2))
  writeFileSync(join(rootDir, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(`\nArtifacts: ${rootDir}`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
