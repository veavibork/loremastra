import type Database from 'better-sqlite3'
import { getBookByType } from '../db/book-store.js'
import { createJob, hasActiveWorldbookCompactJob, type JobRow } from '../db/job-store.js'
import { getDecryptedFeatherlessKey } from '../db/user-store.js'
import { getGlobalDb } from '../db/global-db.js'
import {
  listWorldbookEntries,
  updateWorldbookEntry,
  normalizeWorldbookStoredContent,
  type WorldbookEntry,
  type WorldbookEntryType,
} from '../db/worldbook-store.js'
import { completeChat, type ChatMessage } from '../inference/featherless.js'
import { WORLDBOOK_COMPACT_SYSTEM_PROMPT } from '../prompts.js'
import { getAgentProfile } from './agent-config.js'
import { estimateTokens } from './story-to-date-engine.js'
import { publishJobCreated } from '../queue/job-events.js'

export interface WorldbookCompactOpts {
  entryType?: WorldbookEntryType
  includeHidden?: boolean
}

const worldbookCompactJobOpts = new Map<string, WorldbookCompactOpts>()

export function setWorldbookCompactJobOpts(jobId: string, opts: WorldbookCompactOpts): void {
  worldbookCompactJobOpts.set(jobId, opts)
}

export function takeWorldbookCompactJobOpts(jobId: string): WorldbookCompactOpts {
  const opts = worldbookCompactJobOpts.get(jobId) ?? {}
  worldbookCompactJobOpts.delete(jobId)
  return opts
}

export interface WorldbookCompactEntryResult {
  pageId: string
  entryType: WorldbookEntryType
  beforeTokens: number
  afterTokens: number
  skipped: boolean
  truncated?: boolean
}

export interface WorldbookCompactResult {
  entries: WorldbookCompactEntryResult[]
  totalBeforeTokens: number
  totalAfterTokens: number
  editorCalls: number
}

const CLOSING_TAG: Record<WorldbookEntryType, string> = {
  content: '[/CONTENT]',
  roster: '[/ROSTER]',
  memory: '[/MEMORY]',
}

/** Strip prompt-leakage prefixes from prior bad compacts or model echo. */
export function stripCompactPromptLeakage(content: string, entryType?: WorldbookEntryType): string {
  if (entryType) return normalizeWorldbookStoredContent(content, entryType)
  let text = content.trim()
  for (let i = 0; i < 3; i++) {
    const next = text
      .replace(/^Entry type:\s*(CONTENT|ROSTER|MEMORY)\s*\n+/i, '')
      .replace(/^Worldbook entry to compact:\s*\n+/i, '')
      .replace(/^\[(CONTENT|ROSTER|MEMORY)\]\s*\n?/i, '')
      .trim()
    if (next === text) break
    text = next
  }
  return text
}

function buildCompactSystemPrompt(entryType: WorldbookEntryType): string {
  return `${WORLDBOOK_COMPACT_SYSTEM_PROMPT}

The entry being compacted is a ${entryType.toUpperCase()} entry (context only — do not echo this label in your output).`
}

function looksTruncated(
  original: string,
  compacted: string,
  entryType: WorldbookEntryType,
  responseLimit: number,
): boolean {
  const closing = CLOSING_TAG[entryType]
  if (original.includes(closing) && !compacted.includes(closing)) return true
  return estimateTokens(compacted) >= Math.floor(responseLimit * 0.92)
}

export function buildWorldbookCompactResultSummary(result: WorldbookCompactResult): string {
  const compacted = result.entries.filter((e) => !e.skipped && !e.truncated)
  const skipped = result.entries.filter((e) => e.skipped && !e.truncated)
  const truncated = result.entries.filter((e) => e.truncated)
  const byType = (type: WorldbookEntryType) => compacted.filter((e) => e.entryType === type).length
  const parts = [
    `${compacted.length}/${result.entries.length} compacted`,
    `${result.editorCalls} Editor call${result.editorCalls === 1 ? '' : 's'}`,
    `${result.totalBeforeTokens}→${result.totalAfterTokens} tok total`,
  ]
  if (byType('content') || byType('roster') || byType('memory')) {
    parts.push(`content×${byType('content')} roster×${byType('roster')} memory×${byType('memory')}`)
  }
  if (skipped.length) parts.push(`${skipped.length} skipped`)
  if (truncated.length) parts.push(`${truncated.length} truncated (output limit — kept original)`)
  return parts.join(' · ')
}

async function compactEntryContent(
  editor: ReturnType<typeof getAgentProfile>,
  apiKey: string,
  entry: WorldbookEntry,
): Promise<string> {
  const source = stripCompactPromptLeakage(entry.content, entry.entryType)
  const messages: ChatMessage[] = [
    { role: 'system', content: buildCompactSystemPrompt(entry.entryType) },
    { role: 'user', content: source },
  ]
  return normalizeWorldbookStoredContent(
    (await completeChat(editor, apiKey, messages, { maxTokens: editor.responseLimit })).trim(),
    entry.entryType,
  )
}

/**
 * Compact every visible worldbook entry in place — one Editor call per entry.
 * Previously experiment-only (`scripts/worldbook-compact-experiment.ts`); not automatic.
 */
export async function compactStoryWorldbook(
  db: Database.Database,
  userId: string,
  opts: { entryType?: WorldbookEntryType; includeHidden?: boolean } = {},
): Promise<WorldbookCompactResult> {
  const worldbook = getBookByType(db, 'worldbook')
  if (!worldbook) throw new Error('worldbook not found')

  const apiKey = getDecryptedFeatherlessKey(getGlobalDb(), userId)
  if (!apiKey) throw new Error('no Featherless API key configured')

  const editor = getAgentProfile(userId, 'editor')
  const entries = listWorldbookEntries(db, worldbook.id, {
    includeHidden: opts.includeHidden ?? false,
  }).filter((e) => !opts.entryType || e.entryType === opts.entryType)

  const results: WorldbookCompactEntryResult[] = []
  let totalBeforeTokens = 0
  let totalAfterTokens = 0
  let editorCalls = 0

  for (const entry of entries) {
    const beforeTokens = estimateTokens(entry.content)
    totalBeforeTokens += beforeTokens

    if (!entry.content.trim()) {
      results.push({
        pageId: entry.pageId,
        entryType: entry.entryType,
        beforeTokens,
        afterTokens: beforeTokens,
        skipped: true,
      })
      totalAfterTokens += beforeTokens
      continue
    }

    editorCalls++
    const compacted = await compactEntryContent(editor, apiKey, entry)
    if (!compacted) {
      results.push({
        pageId: entry.pageId,
        entryType: entry.entryType,
        beforeTokens,
        afterTokens: beforeTokens,
        skipped: true,
      })
      totalAfterTokens += beforeTokens
      continue
    }

    if (looksTruncated(entry.content, compacted, entry.entryType, editor.responseLimit)) {
      results.push({
        pageId: entry.pageId,
        entryType: entry.entryType,
        beforeTokens,
        afterTokens: beforeTokens,
        skipped: true,
        truncated: true,
      })
      totalAfterTokens += beforeTokens
      continue
    }

    updateWorldbookEntry(db, entry.pageId, { content: compacted })
    const afterTokens = estimateTokens(compacted)
    totalAfterTokens += afterTokens
    results.push({
      pageId: entry.pageId,
      entryType: entry.entryType,
      beforeTokens,
      afterTokens,
      skipped: false,
    })
  }

  return { entries: results, totalBeforeTokens, totalAfterTokens, editorCalls }
}

/** Enqueue a worldbook-compact job — one Editor call per entry, executed on the worker lane. */
export function enqueueWorldbookCompactJob(
  db: Database.Database,
  userId: string,
  opts: WorldbookCompactOpts = {},
): JobRow {
  if (hasActiveWorldbookCompactJob(db)) {
    throw new Error('worldbook crunch already in progress')
  }

  const worldbook = getBookByType(db, 'worldbook')
  if (!worldbook) throw new Error('worldbook not found')

  const entries = listWorldbookEntries(db, worldbook.id, {
    includeHidden: opts.includeHidden ?? false,
  }).filter((e) => !opts.entryType || e.entryType === opts.entryType)
  if (!entries.length) throw new Error('no worldbook entries to compact')

  const job = createJob(db, {
    targetTextId: entries[0]!.currentTextId,
    jobType: 'worldbook-compact',
    slotCost: getAgentProfile(userId, 'editor').concurrencyCost,
    priority: 0,
  })
  setWorldbookCompactJobOpts(job.id, opts)
  publishJobCreated(job.id, job.jobType)
  return job
}
