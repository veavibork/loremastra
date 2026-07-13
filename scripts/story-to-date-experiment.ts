#!/usr/bin/env npx tsx
/**
 * Direct Featherless experiment for [STORY BEGINS] / [STORY CONTINUES] archival.
 * Not integrated into the pipeline — iterate on prompts and review artifacts before committing.
 *
 * Usage:
 *   npx tsx scripts/story-to-date-experiment.ts list
 *   npx tsx scripts/story-to-date-experiment.ts corpus <storyId> [--cutoff 0.8] [--trigger 0.8]
 *   npx tsx scripts/story-to-date-experiment.ts run <storyId> --mode begins|continues [--cutoff 0.8] [--prior ./path/to/prior.txt] [--system ./custom-prompt.txt] [--dry-run]
 *
 * Requires Featherless API key in global DB for the story owner (same as the running app).
 * Artifacts: data/experiments/story-to-date/<timestamp>-<storyId>/
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

try {
  process.loadEnvFile()
} catch {
  /* no .env */
}

import { getGlobalDb } from '../src/db/global-db.js'
import { getStoryDb } from '../src/db/story-db.js'
import { getStory, listStories } from '../src/db/story-store.js'
import { listUsers } from '../src/db/user-store.js'
import { getBookByType } from '../src/db/book-store.js'
import { getDecryptedFeatherlessKey } from '../src/db/user-store.js'
import { getAgentProfile } from '../src/services/agent-config.js'
import { completeChat } from '../src/inference/featherless.js'
import {
  buildExperimentMessages,
  buildSeamRetryUserMessage,
  buildStoryCorpus,
  extractCoverage,
  extractStoryBlock,
  formatCorpusForEditor,
  mergeStoryToDate,
  shouldRetrySeamGate,
  wouldTriggerStoryToDate,
  type StoryBlockKind,
  type StoryToDateSegment,
  type VerbosePost,
} from '../src/services/story-to-date-engine.js'

function usage(): never {
  console.error(`Usage:
  npx tsx scripts/story-to-date-experiment.ts list
  npx tsx scripts/story-to-date-experiment.ts corpus <storyId> [--cutoff 0.8] [--trigger 0.8]
  npx tsx scripts/story-to-date-experiment.ts run <storyId> --mode begins|continues [options]

Options:
  --cutoff <0-1>     Fraction of usable context for Editor input (default 0.8 — full log to trigger)
  --trigger <0-1>    Threshold for "would queue job" stat (default 0.8)
  --prior <path>     Existing [STORY TO DATE] text (required for continues unless --prior-auto)
  --prior-auto       Use merged segments from a previous artifact dir (--from-artifact)
  --from-artifact <dir>  Load segments.json from a prior run
  --system <path>    Override system prompt (iterate on language without editing code)
  --through-post <N> Force input through IC post N (overrides token cutoff — for mid-scene tests)
  --no-seam-retry   Skip retry when [COVERAGE] equals input ceiling (mid-scene gate)
  --editor           Use Editor agent profile (default). Worker/Author not supported here.
`)
  process.exit(1)
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag)
}

function parseOptionalInt(args: string[], flag: string): number | undefined {
  const raw = argValue(args, flag)
  if (raw == null) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive integer`)
  return Math.floor(n)
}

function parseFraction(args: string[], flag: string, defaultVal: number): number {
  const raw = argValue(args, flag)
  if (raw == null) return defaultVal
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0 || n > 1) throw new Error(`${flag} must be a number in (0, 1]`)
  return n
}

function artifactDir(storyId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = join('data', 'experiments', 'story-to-date', `${stamp}-${storyId.slice(0, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function loadStoryContext(storyId: string, opts: { requireApiKey?: boolean } = {}) {
  const globalDb = getGlobalDb()
  const story = getStory(globalDb, storyId)
  if (!story) throw new Error(`story not found: ${storyId}`)
  const db = getStoryDb(storyId)
  const logbook = getBookByType(db, 'logbook')
  if (!logbook) throw new Error('story has no logbook')
  const author = getAgentProfile(story.ownerUserId, 'author')
  const editor = getAgentProfile(story.ownerUserId, 'editor')
  let apiKey = process.env.FEATHERLESS_API_KEY?.trim() ?? ''
  if (!apiKey) {
    try {
      apiKey = getDecryptedFeatherlessKey(globalDb, story.ownerUserId) ?? ''
    } catch {
      apiKey = ''
    }
  }
  if (opts.requireApiKey && !apiKey) {
    throw new Error(
      'no Featherless API key — set FEATHERLESS_API_KEY env or use DB key (requires matching APP_MASTER_KEY from VM)',
    )
  }
  return { story, db, logbook, author, editor, apiKey, userId: story.ownerUserId }
}

function printCorpusSummary(corpus: ReturnType<typeof buildStoryCorpus>, trigger: number): void {
  console.log(
    JSON.stringify(
      {
        storyId: corpus.storyId,
        postsTotal: corpus.posts.length,
        postsIncluded: corpus.includedPosts.length,
        inputCeilingPost: corpus.inputCeilingPost,
        kickoffPageId: corpus.kickoffPageId,
        tokens: {
          system: corpus.systemTokens,
          worldbook: corpus.worldbookTokens,
          historyFull: corpus.historyTokens,
          historyIncluded: corpus.includedHistoryTokens,
          fullPrompt: corpus.fullPromptTokens,
          includedPrompt: corpus.includedPromptTokens,
          usableBudget: corpus.usableBudget,
          contextLimit: corpus.contextLimit,
          responseReserve: corpus.responseLimit,
        },
        wouldTriggerAt: trigger,
        wouldTrigger: wouldTriggerStoryToDate(corpus, trigger),
        fillRatio: (corpus.fullPromptTokens / corpus.usableBudget).toFixed(3),
      },
      null,
      2,
    ),
  )
}

function cmdList(): void {
  const globalDb = getGlobalDb()
  const users = listUsers(globalDb)
  if (!users.length) {
    console.log('(no users)')
    return
  }
  for (const user of users) {
    for (const s of listStories(globalDb, user.id)) {
      console.log(`${s.id}  ${s.name}`)
    }
  }
}

function cmdCorpus(storyId: string, args: string[]): void {
  const cutoff = parseFraction(args, '--cutoff', 0.8)
  const throughPost = parseOptionalInt(args, '--through-post')
  const trigger = parseFraction(args, '--trigger', 0.8)
  const { db, logbook, author } = loadStoryContext(storyId)
  const corpus = buildStoryCorpus(db, storyId, logbook.id, {
    contextLimit: author.contextLimit,
    responseLimit: author.responseLimit,
    inputCutoff: cutoff,
    throughPost,
  })
  printCorpusSummary(corpus, trigger)
  const dir = artifactDir(storyId)
  writeFileSync(join(dir, 'corpus-meta.json'), JSON.stringify(corpus, null, 2))
  writeFileSync(join(dir, 'corpus-input.txt'), formatCorpusForEditor(corpus))
  console.log(`\nWrote ${dir}/corpus-input.txt (${corpus.includedPosts.length} posts)`)
}

function findPostByIcNumber(posts: VerbosePost[], icPostNumber: number): VerbosePost | undefined {
  return posts.find((p) => p.icPostNumber === icPostNumber)
}

interface ParsedEditorResponse {
  raw: string
  block: string
  coverageThroughPost: number
}

function parseEditorResponse(raw: string, mode: StoryBlockKind): ParsedEditorResponse | null {
  const block = extractStoryBlock(raw, mode)
  const coverageThroughPost = extractCoverage(raw)
  if (!block || coverageThroughPost == null) return null
  return { raw, block, coverageThroughPost }
}

function checkCoverage(
  mode: StoryBlockKind,
  coverageThroughPost: number,
  corpus: ReturnType<typeof buildStoryCorpus>,
  priorCoveragePost: number | undefined,
  includedPosts: VerbosePost[],
): { ok: true; post: VerbosePost } | { ok: false; reason: string } {
  if (corpus.inputCeilingPost != null && coverageThroughPost > corpus.inputCeilingPost) {
    return { ok: false, reason: `exceeds ceiling ${corpus.inputCeilingPost}` }
  }
  if (
    mode === 'continues' &&
    priorCoveragePost != null &&
    coverageThroughPost <= priorCoveragePost
  ) {
    return { ok: false, reason: `must advance beyond prior coverage ${priorCoveragePost}` }
  }
  const post = findPostByIcNumber(includedPosts, coverageThroughPost)
  if (!post) {
    return { ok: false, reason: `post not in included input (ceiling ${corpus.inputCeilingPost})` }
  }
  return { ok: true, post }
}

function validateCoverageOrExit(
  mode: StoryBlockKind,
  coverageThroughPost: number,
  corpus: ReturnType<typeof buildStoryCorpus>,
  priorCoveragePost: number | undefined,
  includedPosts: VerbosePost[],
): VerbosePost {
  const result = checkCoverage(mode, coverageThroughPost, corpus, priorCoveragePost, includedPosts)
  if (!result.ok) {
    console.error(`\nCoverage post ${coverageThroughPost} ${result.reason}`)
    process.exit(1)
  }
  return result.post
}

async function cmdRun(storyId: string, args: string[]): Promise<void> {
  const modeRaw = argValue(args, '--mode')
  if (modeRaw !== 'begins' && modeRaw !== 'continues') usage()
  const mode = modeRaw as StoryBlockKind
  const cutoff = parseFraction(args, '--cutoff', 0.8)
  const throughPost = parseOptionalInt(args, '--through-post')
  const dryRun = hasFlag(args, '--dry-run')
  const noSeamRetry = hasFlag(args, '--no-seam-retry')
  const systemPath = argValue(args, '--system')
  const systemOverride = systemPath ? readFileSync(systemPath, 'utf-8') : undefined

  const { db, logbook, author, editor, apiKey } = loadStoryContext(storyId, { requireApiKey: true })

  let afterPageId: string | undefined
  let priorCoveragePost: number | undefined
  let priorStoryToDate = argValue(args, '--prior')
    ? readFileSync(argValue(args, '--prior')!, 'utf-8')
    : undefined
  const fromArtifact = argValue(args, '--from-artifact')
  if (fromArtifact) {
    const segPath = join(fromArtifact, 'segments.json')
    if (existsSync(segPath)) {
      const segments = JSON.parse(readFileSync(segPath, 'utf-8')) as StoryToDateSegment[]
      const last = segments[segments.length - 1]
      if (last?.coveragePageId) afterPageId = last.coveragePageId
      if (last?.coverageThroughPost) priorCoveragePost = last.coverageThroughPost
      priorStoryToDate = priorStoryToDate ?? mergeStoryToDate(segments)
    }
    const mergedPath = join(fromArtifact, 'story-to-date-merged.txt')
    if (!priorStoryToDate?.trim() && existsSync(mergedPath)) {
      priorStoryToDate = readFileSync(mergedPath, 'utf-8')
    }
  }

  const corpus = buildStoryCorpus(db, storyId, logbook.id, {
    contextLimit: author.contextLimit,
    responseLimit: author.responseLimit,
    inputCutoff: cutoff,
    throughPost,
    afterPageId: mode === 'continues' ? afterPageId : undefined,
    priorStoryToDate: mode === 'continues' ? priorStoryToDate : undefined,
  })

  if (mode === 'continues' && !priorStoryToDate?.trim()) {
    throw new Error(
      'continues mode needs --prior <file> or --from-artifact <dir> with segments.json',
    )
  }

  const messages = buildExperimentMessages(mode, corpus, {
    priorStoryToDate,
    priorCoveragePost: mode === 'continues' ? priorCoveragePost : undefined,
    systemPromptOverride: systemOverride,
  })

  const dir = artifactDir(storyId)
  writeFileSync(
    join(dir, 'corpus-meta.json'),
    JSON.stringify(
      {
        mode,
        cutoff,
        throughPost: throughPost ?? null,
        afterPageId: afterPageId ?? null,
        priorCoveragePost: priorCoveragePost ?? null,
        postsIncluded: corpus.includedPosts.length,
        inputCeilingPost: corpus.inputCeilingPost,
        inputCeilingPageId: corpus.inputCeilingPageId,
        kickoffPageId: corpus.kickoffPageId,
        fullPromptTokens: corpus.fullPromptTokens,
        includedPromptTokens: corpus.includedPromptTokens,
      },
      null,
      2,
    ),
  )
  writeFileSync(join(dir, 'messages.json'), JSON.stringify(messages, null, 2))
  writeFileSync(join(dir, 'system-prompt.txt'), messages[0]!.content!)
  writeFileSync(join(dir, 'user-prompt.txt'), messages[1]!.content!)

  console.log(`Artifacts: ${dir}`)
  printCorpusSummary(corpus, parseFraction(args, '--trigger', 0.8))

  if (dryRun) {
    console.log('\n--dry-run: skipping Featherless call')
    return
  }

  console.log(`\nCalling Featherless (Editor: ${editor.model})…`)
  let raw = await completeChat(editor, apiKey, messages, { maxTokens: editor.responseLimit })
  writeFileSync(join(dir, 'response-raw.txt'), raw)

  let parsed = parseEditorResponse(raw, mode)
  if (!parsed) {
    console.error(
      '\nNo [STORY ' +
        mode.toUpperCase() +
        '] block or [COVERAGE] in response. See response-raw.txt',
    )
    process.exit(1)
  }

  let seamRetried = false
  const ceiling = corpus.inputCeilingPost
  if (!noSeamRetry && ceiling != null && shouldRetrySeamGate(parsed.coverageThroughPost, ceiling)) {
    console.log(
      `\nSeam gate: [COVERAGE]${parsed.coverageThroughPost} equals ceiling post ${ceiling} — retrying with step-back instruction…`,
    )
    const retryMessages = [
      ...messages,
      { role: 'assistant' as const, content: parsed.raw },
      {
        role: 'user' as const,
        content: buildSeamRetryUserMessage(mode, parsed.coverageThroughPost, ceiling),
      },
    ]
    writeFileSync(join(dir, 'messages-retry.json'), JSON.stringify(retryMessages, null, 2))
    const retryRaw = await completeChat(editor, apiKey, retryMessages, {
      maxTokens: editor.responseLimit,
    })
    writeFileSync(join(dir, 'response-raw-retry.txt'), retryRaw)

    const retryParsed = parseEditorResponse(retryRaw, mode)
    if (!retryParsed) {
      console.warn('Retry response missing block or coverage — keeping first response.')
    } else {
      const retryCheck = checkCoverage(
        mode,
        retryParsed.coverageThroughPost,
        corpus,
        priorCoveragePost,
        corpus.includedPosts,
      )
      if (retryCheck.ok && retryParsed.coverageThroughPost < parsed.coverageThroughPost) {
        parsed = retryParsed
        raw = retryRaw
        seamRetried = true
        console.log(`Retry stepped coverage back to post ${parsed.coverageThroughPost}.`)
      } else if (retryCheck.ok && retryParsed.coverageThroughPost === parsed.coverageThroughPost) {
        console.warn(`Retry still at ceiling post ${ceiling} — keeping first response.`)
      } else if (!retryCheck.ok) {
        console.warn(`Retry coverage invalid (${retryCheck.reason}) — keeping first response.`)
      } else {
        console.warn(
          `Retry coverage post ${retryParsed.coverageThroughPost} not lower than first — keeping first response.`,
        )
      }
    }
  }

  const { block, coverageThroughPost } = parsed
  const coveragePost = validateCoverageOrExit(
    mode,
    coverageThroughPost,
    corpus,
    priorCoveragePost,
    corpus.includedPosts,
  )

  if (throughPost != null && coverageThroughPost === throughPost && !seamRetried) {
    console.warn(
      `\nNote: coverage equals through-post ${throughPost} after ${seamRetried ? 'retry' : 'first pass'}.`,
    )
  }

  writeFileSync(join(dir, `block-${mode}.txt`), block)
  writeFileSync(join(dir, 'coverage.txt'), `[COVERAGE]${coverageThroughPost}[/COVERAGE]`)

  const segment: StoryToDateSegment = {
    kind: mode,
    content: block,
    coverageThroughPost,
    coveragePageId: coveragePost.pageId,
  }

  const segments: StoryToDateSegment[] = []
  if (fromArtifact && existsSync(join(fromArtifact, 'segments.json'))) {
    segments.push(
      ...(JSON.parse(
        readFileSync(join(fromArtifact, 'segments.json'), 'utf-8'),
      ) as StoryToDateSegment[]),
    )
  }
  segments.push(segment)
  writeFileSync(join(dir, 'segments.json'), JSON.stringify(segments, null, 2))
  writeFileSync(join(dir, 'story-to-date-merged.txt'), mergeStoryToDate(segments))

  const inputPosts = corpus.includedPosts.length
  const outputWords = block.split(/\s+/).filter(Boolean).length
  writeFileSync(
    join(dir, 'metrics.json'),
    JSON.stringify(
      {
        inputPosts,
        inputCeilingPost: corpus.inputCeilingPost,
        coverageThroughPost,
        seamRetried,
        outputChars: block.length,
        outputWords,
        compressionPostsPerWord: inputPosts / outputWords,
      },
      null,
      2,
    ),
  )

  console.log(
    `\nExtracted [STORY ${mode.toUpperCase()}] (${block.length} chars, ${outputWords} words)`,
  )
  console.log(`Coverage: [COVERAGE]${coverageThroughPost}[/COVERAGE] → page ${coveragePost.pageId}`)
  console.log(`Merged [STORY TO DATE] → ${dir}/story-to-date-merged.txt`)
  console.log('\n--- preview ---\n' + block.slice(0, 1200) + (block.length > 1200 ? '\n…' : ''))
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const cmd = args[0]
  if (!cmd || cmd === 'help' || cmd === '-h') usage()

  if (cmd === 'list') {
    cmdList()
    return
  }

  const storyId = args[1]
  if (!storyId) usage()

  if (cmd === 'corpus') {
    cmdCorpus(storyId, args.slice(2))
    return
  }

  if (cmd === 'run') {
    await cmdRun(storyId, args.slice(2))
    return
  }

  usage()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
