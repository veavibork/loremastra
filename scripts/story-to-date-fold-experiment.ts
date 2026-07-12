#!/usr/bin/env npx tsx
/**
 * Story-to-date FOLD experiment (feature A: bounded memory via recursive re-compression).
 * Takes the current STORY TO DATE segments, folds the OLDEST ones into a single compact
 * "deep past" digest (resolution-status dropping rule), keeps the recent segments verbatim,
 * and reports the token picture. Standalone; no DB writes.
 *
 * Usage:
 *   LOREMASTER_DATA_DIR=data/vm-sync npx tsx scripts/story-to-date-fold-experiment.ts <storyId> [--keep-recent N] [--target-words N]
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
import { getDecryptedFeatherlessKey } from '../src/db/user-store.js'
import { getAgentProfile } from '../src/services/agent-config.js'
import { completeChat, type ChatMessage } from '../src/inference/featherless.js'
import { listStoryToDateSegments } from '../src/db/story-to-date-store.js'
import { estimateTokens } from '../src/services/story-to-date-corpus.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function completeChatRetrying(
  editor: any,
  apiKey: string,
  messages: ChatMessage[],
): Promise<string> {
  const delays = [15000, 30000, 45000, 60000, 90000]
  for (let attempt = 0; ; attempt++) {
    try {
      return await completeChat(editor, apiKey, messages, { maxTokens: editor.responseLimit })
    } catch (err: any) {
      const is429 = err?.status === 429 || String(err?.message ?? '').includes('429')
      if (!is429 || attempt >= delays.length) throw err
      console.log(
        `  (429 — waiting ${delays[attempt]! / 1000}s, retry ${attempt + 1}/${delays.length})`,
      )
      await sleep(delays[attempt]!)
    }
  }
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length

function buildFoldSystem(targetWords: number): string {
  return `You are the Editor, condensing the older portion of a long story's memory into a compact "deep past" digest. The recent memory is kept separately in full — your job is only the older material provided here.

The text you receive is ALREADY a compressed, chronological memory of events. Compress it further: this is the distant past, where fine detail no longer matters, but the through-line must survive intact.

KEEP at full weight: unresolved threads; open promises, debts, and plans; secrets not yet revealed; standing relationships and their current state; deaths and permanent changes; injuries or conditions still in effect; anything a future scene or character could still reference or contradict.

COMPRESS hard or drop entirely: resolved sub-threads (a conflict that ended, a task that got done); one-off events with no lasting consequence; scene-level color and staging; anything already fully paid off. A resolved beat shrinks to a clause; an unresolved one keeps its shape.

Preserve chronology and the causal throughline (this led to that). Use proper names; never "you/your" for the player character. Do not invent events. Do not reference or fold in the recent memory — it is not here.

Length: aim for about ${targetWords} words — the load-bearing spine of the deep past, no more. Write flowing third-person prose in the same register as the input.

Output ONLY the digest prose — no headings, labels, or commentary.`
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const storyId = args[0]
  if (!storyId) {
    console.error(
      'usage: story-to-date-fold-experiment.ts <storyId> [--keep-recent N] [--target-words N]',
    )
    process.exit(1)
  }
  const keepRecent =
    args.indexOf('--keep-recent') >= 0 ? Number(args[args.indexOf('--keep-recent') + 1]) : 5
  const targetArg =
    args.indexOf('--target-words') >= 0 ? Number(args[args.indexOf('--target-words') + 1]) : null

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

  const segs = listStoryToDateSegments(db, logbook.id).filter((s) => s.content?.trim() && !s.broken)
  if (segs.length <= keepRecent)
    throw new Error(`only ${segs.length} segments; nothing to fold with keep-recent=${keepRecent}`)

  const oldSegs = segs.slice(0, segs.length - keepRecent)
  const recentSegs = segs.slice(segs.length - keepRecent)
  const oldMerged = oldSegs.map((s) => s.content!.trim()).join('\n\n')
  const oldTok = estimateTokens(oldMerged)
  const oldWords = words(oldMerged)
  const recentTok = recentSegs.reduce((a, s) => a + estimateTokens(s.content!), 0)
  const foldedCoverage = oldSegs[oldSegs.length - 1]!.coverageThroughIcPost

  const targetWords = targetArg ?? Math.round(oldWords * 0.45)
  const messages: ChatMessage[] = [
    { role: 'system', content: buildFoldSystem(targetWords) },
    { role: 'user', content: `Older memory to condense (chronological):\n\n${oldMerged}` },
  ]

  console.log(
    `Folding oldest ${oldSegs.length} segments (through post ${foldedCoverage}), keeping recent ${recentSegs.length}.`,
  )
  console.log(`Old: ${oldWords}w / ${oldTok}tok  →  target ~${targetWords}w`)
  console.log(`Calling Editor (${editor.model})…`)

  const digest = (await completeChatRetrying(editor, apiKey, messages)).trim()
  const digestTok = estimateTokens(digest)
  const digestWords = words(digest)

  const totalBefore = segs.reduce((a, s) => a + estimateTokens(s.content!), 0)
  const totalAfter = digestTok + recentTok

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join('data', 'experiments', 'story-to-date-fold', `${stamp}-${storyId.slice(0, 8)}`)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'old-merged-before.txt'), oldMerged)
  writeFileSync(join(root, 'digest-after.txt'), digest)
  writeFileSync(
    join(root, 'summary.json'),
    JSON.stringify(
      {
        segmentsFolded: oldSegs.length,
        segmentsKept: recentSegs.length,
        foldedThroughPost: foldedCoverage,
        oldWords,
        oldTok,
        targetWords,
        digestWords,
        digestTok,
        foldReductionPct: Math.round((1 - digestTok / oldTok) * 100),
        totalBeforeTok: totalBefore,
        totalAfterTok: totalAfter,
        totalReductionPct: Math.round((1 - totalAfter / totalBefore) * 100),
      },
      null,
      2,
    ),
  )

  console.log(
    `\nDigest: ${digestWords}w / ${digestTok}tok  (folded ${oldTok}→${digestTok}, ${Math.round((1 - digestTok / oldTok) * 100)}% cut)`,
  )
  console.log(
    `STORY TO DATE total: ${totalBefore} → ${totalAfter} tok  (${Math.round((1 - totalAfter / totalBefore) * 100)}% cut, and now BOUNDED)`,
  )
  console.log(`Artifacts: ${root}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
