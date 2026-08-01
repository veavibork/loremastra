#!/usr/bin/env npx tsx
/**
 * A/B experiment: does revised INCLUDE_EXCLUDE_GUIDANCE wording (and/or different sampler
 * params) reduce dropped consequential events in next-scene continues blocks?
 *
 * Root case (2026-08-01, VM story 019fa8c7, Qwen/Qwen3.6-35B-A3B editor): the Brookline-bust
 * scene's entity encounter and the cause of Junie's arm injury were both dropped entirely from
 * the continues block that claimed to cover them — reduced to "the supernatural threat" and "her
 * injured arm" with no antecedent. The current guidance's "compress hardest on high-affect beats"
 * instruction appears to license dropping the WHOLE event, not just its blow-by-blow staging.
 *
 * Each arm = a guidance-text variant crossed with a sampler override. All arms use the real
 * production prompt path (buildNextSceneContinuesSystemPrompt) and are scored by the same
 * consequential-event judge (borrowed from story-to-date-verify-ab.ts) — measurement only, not
 * production gating (the 2026-07-17 verify-ab finding against unattended judge-gating still
 * stands; this is an offline experiment run by a human).
 *
 * Usage (against the pulled VM save):
 *   $env:LOREMASTER_DATA_DIR = "data/vm-sync"
 *   npx tsx scripts/story-to-date-guidance-ab.ts <storyId> [--trials 5] [--after 1] [--arms a,b,c,d] [--model Qwen/...]
 *
 * Requires FEATHERLESS_API_KEY env or a decryptable key in the global DB (APP_MASTER_KEY).
 * Artifacts: data/experiments/guidance-ab/<stamp>/
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
  buildNextSceneCeilingInstruction,
  buildNextSceneContinuesSystemPrompt,
  buildSeamRetryUserMessage,
  buildStoryCorpus,
  extractCoverage,
  extractStoryBlock,
  formatCorpusForEditor,
  hasLeakedStoryMarkers,
  INCLUDE_EXCLUDE_GUIDANCE,
  looksNextSceneCoverageSprint,
  mergeStoryToDate,
  NEXT_SCENE_CONTINUES_ADDENDUM,
  NEXT_SCENE_INPUT_WINDOW_POSTS,
  NEXT_SCENE_LENGTH_INSTRUCTION,
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

/**
 * Checklist/scaffolding variant (2026-08-01 follow-up): guidance-text and temperature tuning
 * alone didn't converge on a clear fix — no arm reliably kept every consequential event in a
 * dense, multi-thread scene. Hypothesis: extraction (what happened) and compression (say it
 * tersely) are two different cognitive tasks, and asking a lightweight model to do both at once
 * in one pass is where events get silently dropped. This has the model enumerate candidate
 * events FIRST (a more mechanical, less judgment-heavy task), then compress from that list —
 * same single API call, no extra latency, just a different output shape.
 */
function buildChecklistSystemPrompt(
  inputCeilingPost: number | null,
  priorCoveragePost: number | null,
  guidance: string,
): string {
  const prior =
    priorCoveragePost != null
      ? `[STORY TO DATE] already covers through post ${priorCoveragePost}. Only summarize posts after ${priorCoveragePost}. Open where [STORY TO DATE] left off — do not skip intervening events.`
      : ''

  return `You are the Editor, extending an existing "story so far" memory block.

You receive the complete worldbook, the current [STORY TO DATE], and new in-character verbose prose that begins after prior coverage ended. Post numbers are absolute from kickoff; hidden turns occupy numbers but are omitted from the log.

${prior}

First, enumerate every consequential event you find in the new log prose under [EVENTS] — one terse fragment per line, not full sentences: state changes, decisions and their consequences, relationship shifts, injuries, secrets, promises, anything a later scene could contradict if forgotten. This list is scratch work, not memory prose — be exhaustive, not polished.

Then write a [STORY CONTINUES] block that picks up where [STORY TO DATE] left off — same Register, third person. This is memory, not narration: telling-only memory — record what future scenes and NPCs must remember, not how it played out beat by beat. Do not re-introduce events already in [STORY TO DATE] — extend the causal spine only. Do not invent events. Append-only: do not contradict or rewrite prior memory. Every item in your [EVENTS] list must be represented in the compressed prose, at least in one clause — if an item doesn't fit inside the length budget, that means the scene boundary is too wide, not that the item should be dropped silently.

${NEXT_SCENE_CONTINUES_ADDENDUM}

${guidance}

${NEXT_SCENE_LENGTH_INSTRUCTION}

${buildNextSceneCeilingInstruction(inputCeilingPost)}

After [STORY CONTINUES], report coverage through [COVERAGE]N[/COVERAGE] where N is the kickoff post number through which this block reaches (absolute). N must be ≤ ${inputCeilingPost ?? 'the highest post in the input'} and must land on a complete scene, not mid-scene.

Output order: [EVENTS]…[/EVENTS] then [STORY CONTINUES]…[/STORY CONTINUES] then [COVERAGE]N[/COVERAGE]. Use the exact closing tag [/STORY CONTINUES] — not [STORY ENDS].`
}

const CALL_TIMEOUT_MS = 5 * 60_000
const MAX_ATTEMPTS = 2

// ---------------------------------------------------------------------------
// Guidance variants
// ---------------------------------------------------------------------------

/** Distinguishes "drop the staging" from "drop the event" — the gap the live failure exposed. */
const GUIDANCE_CAUSE_CLAUSE = `${INCLUDE_EXCLUDE_GUIDANCE}

Compressing HOW something happened is not the same as dropping THAT it happened and WHY it matters: even in a high-affect or action beat, keep the specific cause of any injury, discovery, or revelation in one clause ("wounded fending off the entity" not just "wounded") while still cutting the blow-by-blow staging around it. A vague label ("the incident," "the supernatural threat") is not memory if a later scene needs the concrete fact underneath it.`

const GUIDANCE_VARIANTS: Record<string, string> = {
  baseline: INCLUDE_EXCLUDE_GUIDANCE,
  causeclause: GUIDANCE_CAUSE_CLAUSE,
}

// ---------------------------------------------------------------------------
// Arms: guidance x sampler override
// ---------------------------------------------------------------------------

interface Arm {
  label: string
  guidanceKey: keyof typeof GUIDANCE_VARIANTS
  profileOverride?: Partial<AgentProfile>
  checklist?: boolean
}

const ALL_ARMS: Record<string, Arm> = {
  a: { label: 'baseline (temp=1, current guidance)', guidanceKey: 'baseline' },
  b: { label: 'cause-clause (temp=1)', guidanceKey: 'causeclause' },
  c: {
    label: 'baseline (temp=0.6)',
    guidanceKey: 'baseline',
    profileOverride: { temperature: 0.6 },
  },
  d: {
    label: 'cause-clause (temp=0.6)',
    guidanceKey: 'causeclause',
    profileOverride: { temperature: 0.6 },
  },
  e: {
    label: 'baseline (temp=0.3)',
    guidanceKey: 'baseline',
    profileOverride: { temperature: 0.3 },
  },
  f: {
    label: 'cause-clause (temp=0.3)',
    guidanceKey: 'causeclause',
    profileOverride: { temperature: 0.3 },
  },
  g: { label: 'checklist (temp=1, baseline guidance)', guidanceKey: 'baseline', checklist: true },
  h: {
    label: 'checklist (temp=0.6, baseline guidance)',
    guidanceKey: 'baseline',
    profileOverride: { temperature: 0.6 },
    checklist: true,
  },
  // Model card's own validated setting (temp=1.0, top_p=0.95) — not a blind guess.
  i: {
    label: 'baseline (temp=1, top_p=0.95)',
    guidanceKey: 'baseline',
    profileOverride: { topP: 0.95 },
  },
}

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
    'Usage: npx tsx scripts/story-to-date-guidance-ab.ts <storyId> [--trials 5] [--after 1] [--arms a,b,c,d] [--model Qwen/...]',
  )
  process.exit(1)
}
const trials = Number(argValue(args, '--trials') ?? 5)
const afterSeq = Number(argValue(args, '--after') ?? 1)
const armKeys = (argValue(args, '--arms') ?? 'a,b,c,d').split(',').map((s) => s.trim())
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
const editorBase: AgentProfile = modelOverride
  ? { ...baseEditor, model: modelOverride }
  : baseEditor
const apiKey =
  process.env.FEATHERLESS_API_KEY?.trim() ||
  getDecryptedFeatherlessKey(globalDb, story.ownerUserId) ||
  ''
if (!apiKey) throw new Error('no Featherless API key (env or DB)')

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const rootDir = join('data', 'experiments', 'guidance-ab', stamp)
mkdirSync(rootDir, { recursive: true })

// ---------------------------------------------------------------------------
// Production-parity generation (mirrors worker.ts, parameterized by guidance + profile)
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
  editor: AgentProfile,
  guidance: string,
  corpus: StoryCorpus,
  priorSegments: StoryToDateSegment[],
  priorStoryToDate: string,
  checklist: boolean,
): Promise<GenOutcome> {
  const priorCoverage = priorSegments[priorSegments.length - 1]!.coverageThroughPost
  const priorBlock = priorSegments[priorSegments.length - 1]!.content
  const system = checklist
    ? buildChecklistSystemPrompt(corpus.inputCeilingPost, priorCoverage, guidance)
    : buildNextSceneContinuesSystemPrompt(corpus.inputCeilingPost, priorCoverage, { guidance })
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
// Judge (borrowed verbatim from story-to-date-verify-ab.ts)
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
  judgeProfile: AgentProfile,
  block: string,
  corpus: StoryCorpus,
  priorCoverage: number,
  coverage: number,
): Promise<JudgeResult | null> {
  const posts = corpus.includedPosts.filter(
    (p) => p.icPostNumber > priorCoverage && p.icPostNumber <= coverage,
  )
  const raw = await completeChat(
    judgeProfile,
    apiKey,
    buildJudgeMessages(block, posts, priorCoverage + 1, coverage),
    { maxTokens: judgeProfile.responseLimit, timeoutMs: CALL_TIMEOUT_MS },
  )
  return parseJudge(raw)
}

// ---------------------------------------------------------------------------
// Trial runner
// ---------------------------------------------------------------------------

interface TrialRow {
  arm: string
  trial: number
  ok: boolean
  failReason?: string
  coverage?: number
  delta?: number
  words?: number
  gateRetries: number
  verdict?: 'pass' | 'fail'
  missingCount?: number
  missing?: string[]
  calls: number
  durationMs: number
}

const rows: TrialRow[] = []

async function runTrial(
  armKey: string,
  arm: Arm,
  editor: AgentProfile,
  judgeProfile: AgentProfile,
  trial: number,
  corpus: StoryCorpus,
  priorSegments: StoryToDateSegment[],
  priorStoryToDate: string,
): Promise<void> {
  const t0 = Date.now()
  const dir = join(rootDir, `${armKey}-t${trial}`)
  mkdirSync(dir, { recursive: true })
  const priorCoverage = priorSegments[priorSegments.length - 1]!.coverageThroughPost
  const guidance = GUIDANCE_VARIANTS[arm.guidanceKey]!

  const gen = await generateCandidate(
    editor,
    guidance,
    corpus,
    priorSegments,
    priorStoryToDate,
    arm.checklist ?? false,
  )
  const calls = gen.calls
  if (!gen.candidate) {
    rows.push({
      arm: armKey,
      trial,
      ok: false,
      failReason: gen.failReason ?? 'unknown',
      gateRetries: gen.gateRetries,
      calls,
      durationMs: Date.now() - t0,
    })
    writeFileSync(join(dir, 'FAILED.txt'), gen.failReason ?? 'unknown')
    gen.failedRaws.forEach((r, i) => writeFileSync(join(dir, `failed-raw-${i + 1}.txt`), r))
    console.log(`  ${armKey} t${trial}: GENERATION FAILED (${gen.failReason})`)
    return
  }

  const final = gen.candidate
  writeFileSync(join(dir, 'gen-raw.txt'), final.raw)
  const judge = await judgeBlock(
    judgeProfile,
    final.block,
    corpus,
    priorCoverage,
    final.coverageThroughPost,
  )
  const totalCalls = calls + 1
  if (judge) writeFileSync(join(dir, 'judge.txt'), judge.raw)

  writeFileSync(join(dir, 'final-block.txt'), final.block)
  const row: TrialRow = {
    arm: armKey,
    trial,
    ok: true,
    coverage: final.coverageThroughPost,
    delta: final.coverageThroughPost - priorCoverage,
    words: storyBlockWordCount(final.block),
    gateRetries: gen.gateRetries,
    verdict: judge?.verdict,
    missingCount: judge?.missing.length,
    missing: judge?.missing,
    calls: totalCalls,
    durationMs: Date.now() - t0,
  }
  rows.push(row)
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(row, null, 2))
  console.log(
    `  ${armKey} t${trial}: cov ${row.coverage} (+${row.delta}), ${row.words}w, ` +
      `judge=${row.verdict}${row.missingCount ? ` (${row.missingCount} missing)` : ''}, ` +
      `${totalCalls} calls, ${Math.round(row.durationMs / 1000)}s`,
  )
  if (judge?.missing.length) {
    judge.missing.forEach((m) => console.log(`      ${m}`))
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const allSegments = listStoryToDateSegments(db, logbook!.id)
    .filter((s) => s.content?.trim() && !s.broken)
    .sort((a, b) => a.seq - b.seq)

  const priorRows = allSegments.filter((s) => s.seq <= afterSeq)
  const last = priorRows[priorRows.length - 1]
  if (!last || last.seq !== afterSeq || !last.coveragePageId) {
    throw new Error(`no filled segment at seq ${afterSeq}`)
  }
  const priorSegments: StoryToDateSegment[] = priorRows.map((s) => ({
    kind: s.kind,
    content: s.content!.trim(),
    coverageThroughPost: s.coverageThroughIcPost ?? 0,
    coveragePageId: s.coveragePageId,
  }))
  const priorStoryToDate = mergeStoryToDate(priorSegments)
  const corpus = buildStoryCorpus(db, storyId!, logbook!.id, {
    contextLimit: editorBase.contextLimit,
    responseLimit: editorBase.responseLimit,
    inputCutoff: STORY_TO_DATE_INPUT_CUTOFF,
    afterPageId: last.coveragePageId,
    priorStoryToDate,
    maxIncludedPosts: NEXT_SCENE_INPUT_WINDOW_POSTS,
  })

  console.log(
    `guidance-ab: story ${storyId}, editor ${editorBase.model}, window ${NEXT_SCENE_INPUT_WINDOW_POSTS}, ` +
      `after-seg${afterSeq} (prior coverage ${last.coverageThroughIcPost}), trials ${trials}, arms [${armKeys.join(', ')}]`,
  )
  console.log(
    `window posts ${corpus.includedPosts[0]?.icPostNumber}–${corpus.inputCeilingPost} (${corpus.includedPosts.length} posts)`,
  )
  console.log(`artifacts: ${rootDir}\n`)

  // Judge always runs at temp=1 baseline params regardless of the arm under test — the judge's
  // OWN sampler settings shouldn't vary with what's being measured.
  const judgeProfile: AgentProfile = { ...editorBase, temperature: 1 }

  for (let trial = 1; trial <= trials; trial++) {
    for (const armKey of armKeys) {
      const arm = ALL_ARMS[armKey]
      if (!arm) {
        console.warn(`unknown arm: ${armKey}`)
        continue
      }
      const editor: AgentProfile = { ...editorBase, ...arm.profileOverride }
      try {
        await runTrial(
          armKey,
          arm,
          editor,
          judgeProfile,
          trial,
          corpus,
          priorSegments,
          priorStoryToDate,
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        rows.push({
          arm: armKey,
          trial,
          ok: false,
          failReason: `call error: ${msg}`,
          gateRetries: 0,
          calls: 0,
          durationMs: 0,
        })
        console.log(`  ${armKey} t${trial}: CALL ERROR (${msg})`)
      }
    }
  }

  // Summary
  const summary: Record<string, unknown>[] = []
  for (const armKey of armKeys) {
    const armRows = rows.filter((r) => r.arm === armKey && r.ok)
    const failures = rows.filter((r) => r.arm === armKey && !r.ok).length
    const passes = armRows.filter((r) => r.verdict === 'pass').length
    const avg = (xs: number[]) =>
      xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null
    summary.push({
      arm: armKey,
      label: ALL_ARMS[armKey]?.label ?? armKey,
      trials: armRows.length,
      genFailures: failures,
      judgePassRate: armRows.length ? `${passes}/${armRows.length}` : '-',
      avgMissing: avg(armRows.map((r) => r.missingCount ?? 0)),
      avgDelta: avg(armRows.map((r) => r.delta ?? 0)),
      avgWords: avg(armRows.map((r) => r.words ?? 0)),
      avgCalls: avg(armRows.map((r) => r.calls)),
    })
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
