#!/usr/bin/env npx tsx
/**
 * A/B experiment: can the Worker profile handle segment-audit, or does it need the Editor?
 *
 * Runs the production audit judge (src/services/story-to-date/audit.ts — same prompt, same
 * parse, same majority tally) over the newest ready continues segments, once per arm:
 *   Arm E: the configured Editor profile (production behavior)
 *   Arm W: the configured Worker profile
 * Read-only — verdicts are NOT written to the segments; artifacts go to
 * data/experiments/segment-audit-ab/<stamp>/.
 *
 * Comparison: parse success rate, per-segment majority verdict agreement (Editor as
 * reference), vote unanimity, missing-line counts, latency.
 *
 * Usage (against the pulled VM save):
 *   $env:LOREMASTER_DATA_DIR = "data/vm-sync"
 *   npx tsx scripts/segment-audit-model-ab.ts <storyId> [--segments 4] [--votes 3] [--worker-model <id>]
 *
 * Requires FEATHERLESS_API_KEY env or a decryptable key in the global DB (APP_MASTER_KEY).
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
import { completeChat } from '../src/inference/featherless.js'
import { buildStoryCorpus } from '../src/services/story-to-date/engine.js'
import {
  AUDIT_MAX_WINDOW_POSTS,
  buildAuditJudgeMessages,
  parseAuditJudge,
  tallyAuditVotes,
  type AuditVote,
} from '../src/services/story-to-date/audit.js'

const CALL_TIMEOUT_MS = 5 * 60_000

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

const args = process.argv.slice(2)
const storyId = args[0]
if (!storyId || storyId.startsWith('--')) {
  console.error(
    'Usage: npx tsx scripts/segment-audit-model-ab.ts <storyId> [--segments 4] [--votes 3] [--worker-model <id>]',
  )
  process.exit(1)
}
const segmentCount = Number(argValue(args, '--segments') ?? 4)
const votesPerArm = Number(argValue(args, '--votes') ?? 3)
const workerModelOverride = argValue(args, '--worker-model')

const globalDb = getGlobalDb()
const story = getStory(globalDb, storyId)
if (!story) throw new Error(`story not found: ${storyId}`)
const db = getStoryDb(storyId, { skipRecovery: true })
const logbook = getBookByType(db, 'logbook')
if (!logbook) throw new Error('story has no logbook')

const editor = getAgentProfile(story.ownerUserId, 'editor')
const baseWorker = getAgentProfile(story.ownerUserId, 'worker')
const worker: AgentProfile = workerModelOverride
  ? { ...baseWorker, model: workerModelOverride }
  : baseWorker
const apiKey =
  process.env.FEATHERLESS_API_KEY?.trim() ||
  getDecryptedFeatherlessKey(globalDb, story.ownerUserId) ||
  ''
if (!apiKey) throw new Error('no Featherless API key (env or DB)')

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const rootDir = join('data', 'experiments', 'segment-audit-ab', stamp)
mkdirSync(rootDir, { recursive: true })

console.log(`Arm E (editor): ${editor.model} (responseLimit ${editor.responseLimit})`)
console.log(`Arm W (worker): ${worker.model} (responseLimit ${worker.responseLimit})`)

// ---------------------------------------------------------------------------

interface SegmentCase {
  id: string
  seq: number
  name: string | null
  fromPost: number
  toPost: number
  messages: ReturnType<typeof buildAuditJudgeMessages>
}

function buildCases(): SegmentCase[] {
  const ready = listStoryToDateSegments(db, logbook!.id).filter(
    (s) => s.content?.trim() && !s.broken && s.coverageThroughIcPost != null,
  )
  const cases: SegmentCase[] = []
  // Newest first, skip anything with an oversized window (fold digests etc.).
  for (const seg of [...ready].sort((a, b) => b.seq - a.seq)) {
    if (cases.length >= segmentCount) break
    const prior = ready
      .filter((s) => s.seq < seg.seq && s.coverageThroughIcPost != null)
      .sort((a, b) => b.seq - a.seq)[0]
    const fromPost = (prior?.coverageThroughIcPost ?? 0) + 1
    const toPost = seg.coverageThroughIcPost!
    const windowPosts = toPost - fromPost + 1
    if (windowPosts < 1 || windowPosts > AUDIT_MAX_WINDOW_POSTS) continue
    const corpus = buildStoryCorpus(db, storyId!, logbook!.id, {
      contextLimit: editor.contextLimit,
      responseLimit: editor.responseLimit,
      afterPageId: prior?.coveragePageId ?? undefined,
      throughPost: toPost,
    })
    const posts = corpus.includedPosts.filter(
      (p) => p.icPostNumber >= fromPost && p.icPostNumber <= toPost,
    )
    if (!posts.length) continue
    cases.push({
      id: seg.id,
      seq: seg.seq,
      name: seg.name,
      fromPost,
      toPost,
      messages: buildAuditJudgeMessages(seg.content!.trim(), posts, fromPost, toPost),
    })
  }
  return cases.reverse() // oldest first for stable reading order
}

interface ArmRun {
  arm: 'E' | 'W'
  parseFailures: number
  votes: AuditVote[]
  verdict: 'pass' | 'flagged' | 'unparseable'
  missingCount: number
  latenciesMs: number[]
}

async function runArm(arm: 'E' | 'W', profile: AgentProfile, c: SegmentCase): Promise<ArmRun> {
  const votes: AuditVote[] = []
  const latenciesMs: number[] = []
  let parseFailures = 0
  for (let i = 1; i <= votesPerArm; i++) {
    const t0 = Date.now()
    let raw = ''
    try {
      raw = await completeChat(profile, apiKey, c.messages, {
        maxTokens: profile.responseLimit,
        timeoutMs: CALL_TIMEOUT_MS,
      })
    } catch (err) {
      raw = `<<call failed: ${err instanceof Error ? err.message : String(err)}>>`
    }
    latenciesMs.push(Date.now() - t0)
    writeFileSync(join(rootDir, `seq${c.seq}-${arm}-vote${i}.txt`), raw)
    const vote = parseAuditJudge(raw)
    if (!vote) {
      parseFailures++
      continue
    }
    votes.push(vote)
    // Same early exit as production: stop once the majority can't change.
    if (tallyAuditVotes(votes, votesPerArm)) break
  }
  const tally = votes.length ? tallyAuditVotes(votes, votes.length) : null
  return {
    arm,
    parseFailures,
    votes,
    verdict: tally?.verdict ?? 'unparseable',
    missingCount: tally?.missing.length ?? 0,
    latenciesMs,
  }
}

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

// ---------------------------------------------------------------------------

const cases = buildCases()
if (!cases.length) throw new Error('no auditable segments found')
console.log(
  `Auditing ${cases.length} segments × 2 arms × up to ${votesPerArm} votes (sequential)\n`,
)

interface Row {
  seq: number
  window: string
  editor: ArmRun
  worker: ArmRun
}
const rows: Row[] = []

for (const c of cases) {
  console.log(`— seq ${c.seq} "${c.name ?? ''}" (posts ${c.fromPost}–${c.toPost})`)
  const editorRun = await runArm('E', editor, c)
  console.log(
    `  E: ${editorRun.verdict} (${editorRun.votes.map((v) => v.verdict).join('/')}, ${editorRun.missingCount} missing, median ${median(editorRun.latenciesMs)}ms)`,
  )
  const workerRun = await runArm('W', worker, c)
  console.log(
    `  W: ${workerRun.verdict} (${workerRun.votes.map((v) => v.verdict).join('/')}, ${workerRun.missingCount} missing, median ${median(workerRun.latenciesMs)}ms${workerRun.parseFailures ? `, ${workerRun.parseFailures} parse failures` : ''})`,
  )
  rows.push({
    seq: c.seq,
    window: `${c.fromPost}–${c.toPost}`,
    editor: editorRun,
    worker: workerRun,
  })
}

// ---------------------------------------------------------------------------

const totalWorkerVotes = rows.reduce(
  (n, r) => n + r.worker.votes.length + r.worker.parseFailures,
  0,
)
const workerParseFailures = rows.reduce((n, r) => n + r.worker.parseFailures, 0)
const decidable = rows.filter(
  (r) => r.editor.verdict !== 'unparseable' && r.worker.verdict !== 'unparseable',
)
const agreements = decidable.filter((r) => r.editor.verdict === r.worker.verdict).length

const summary = {
  editorModel: editor.model,
  workerModel: worker.model,
  segments: rows.map((r) => ({
    seq: r.seq,
    window: r.window,
    editorVerdict: r.editor.verdict,
    workerVerdict: r.worker.verdict,
    editorMissing: r.editor.missingCount,
    workerMissing: r.worker.missingCount,
    editorMedianMs: median(r.editor.latenciesMs),
    workerMedianMs: median(r.worker.latenciesMs),
  })),
  workerParseFailureRate: `${workerParseFailures}/${totalWorkerVotes}`,
  verdictAgreement: `${agreements}/${decidable.length}`,
  medianLatencyMs: {
    editor: median(rows.flatMap((r) => r.editor.latenciesMs)),
    worker: median(rows.flatMap((r) => r.worker.latenciesMs)),
  },
}
writeFileSync(join(rootDir, 'summary.json'), JSON.stringify(summary, null, 2))

console.log('\n=== Summary ===')
console.log(JSON.stringify(summary, null, 2))
console.log(`\nArtifacts: ${rootDir}`)
