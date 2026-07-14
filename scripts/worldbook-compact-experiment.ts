#!/usr/bin/env npx tsx
/**
 * Worldbook compaction experiment — per-entry token reduction that preserves original-state
 * characterization/voice and generation directives, trimming only redundant prose and
 * plot-secrets the STORY TO DATE shows are already revealed. Standalone; no DB writes.
 *
 * Usage:
 *   LOREMASTER_DATA_DIR=data/vm-sync npx tsx scripts/worldbook-compact-experiment.ts <storyId> [--only content|roster|memory] [--limit N] [--dry-run]
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
import { listWorldbookEntries } from '../src/db/worldbook-store.js'
import { estimateTokens } from '../src/services/story-to-date/engine.js'

const COMPACT_SYSTEM = `You are the Editor, compacting a single worldbook entry to reduce its token count without changing what it establishes.

Rewrite the entry more concisely: tighten redundant restatements and purple prose so each thing is said once, well.

Preserve exactly, in meaning:
- Every field and heading — do not drop, empty, merge, rename, or reorder any of them.
- All identity, physical description, characterization, voice, and subtext.
- Any generation directives (tone/register guidance, Embrace/Refuse/content rules).
- The character or place at their ORIGINAL state — do not advance them to their current story state, add traits, or infer anything not already written.

Output ONLY the rewritten entry — no preamble, no commentary, no code fences.`

function words(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The Featherless plan caps concurrency at 4 units and DeepSeek costs 4/request, so this
 * experiment competes with the live app for the single slot. Back off on 429 and retry. */
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
      const wait = delays[attempt]!
      console.log(
        `  (429 concurrency — waiting ${wait / 1000}s for a slot, retry ${attempt + 1}/${delays.length})`,
      )
      await sleep(wait)
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const storyId = args[0]
  if (!storyId) {
    console.error(
      'usage: worldbook-compact-experiment.ts <storyId> [--only TYPE] [--limit N] [--dry-run]',
    )
    process.exit(1)
  }
  const only = args.indexOf('--only') >= 0 ? args[args.indexOf('--only') + 1] : null
  const limit = args.indexOf('--limit') >= 0 ? Number(args[args.indexOf('--limit') + 1]) : Infinity
  const dryRun = args.includes('--dry-run')

  const globalDb = getGlobalDb()
  const story = getStory(globalDb, storyId)
  if (!story) throw new Error(`story not found: ${storyId}`)
  const db = getStoryDb(storyId)
  const wb = getBookByType(db, 'worldbook')
  const logbook = getBookByType(db, 'logbook')
  if (!wb || !logbook) throw new Error('missing worldbook/logbook')
  const editor = getAgentProfile(story.ownerUserId, 'editor')

  let apiKey = process.env.FEATHERLESS_API_KEY?.trim() ?? ''
  if (!apiKey) {
    try {
      apiKey = getDecryptedFeatherlessKey(globalDb, story.ownerUserId) ?? ''
    } catch {
      apiKey = ''
    }
  }
  if (!apiKey && !dryRun)
    throw new Error('no Featherless API key (set FEATHERLESS_API_KEY or provide APP_MASTER_KEY)')

  const entries = listWorldbookEntries(db, wb.id).filter((e) => !only || e.entryType === only)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join('data', 'experiments', 'worldbook-compact', `${stamp}-${storyId.slice(0, 8)}`)
  mkdirSync(root, { recursive: true })

  const rows: any[] = []
  let i = 0
  for (const e of entries) {
    if (i >= limit) break
    const beforeTok = estimateTokens(e.content)
    const user = `Entry type: ${e.entryType.toUpperCase()}

Worldbook entry to compact:
${e.content}`
    const messages: ChatMessage[] = [
      { role: 'system', content: COMPACT_SYSTEM },
      { role: 'user', content: user },
    ]

    let after = ''
    if (!dryRun) {
      after = (await completeChatRetrying(editor, apiKey, messages)).trim()
    }
    const afterTok = estimateTokens(after)
    const row = {
      idx: i,
      type: e.entryType,
      pageId: e.pageId,
      beforeTok,
      beforeWords: words(e.content),
      afterTok,
      afterWords: words(after),
      reductionPct: beforeTok ? Math.round((1 - afterTok / beforeTok) * 100) : 0,
    }
    rows.push(row)
    writeFileSync(join(root, `${i}-${e.entryType}-before.txt`), e.content)
    writeFileSync(join(root, `${i}-${e.entryType}-after.txt`), after)
    console.log(`[${i}] ${e.entryType}: ${beforeTok} → ${afterTok} tok (${row.reductionPct}% cut)`)
    i++
  }

  const totBefore = rows.reduce((a, r) => a + r.beforeTok, 0)
  const totAfter = rows.reduce((a, r) => a + r.afterTok, 0)
  const summary = {
    storyId,
    editorModel: editor.model,
    entries: rows.length,
    totalBeforeTok: totBefore,
    totalAfterTok: totAfter,
    totalReductionPct: totBefore ? Math.round((1 - totAfter / totBefore) * 100) : 0,
    rows,
  }
  writeFileSync(join(root, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(
    `\nTOTAL: ${totBefore} → ${totAfter} tok (${summary.totalReductionPct}% cut across ${rows.length} entries)`,
  )
  console.log(`Artifacts: ${root}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
