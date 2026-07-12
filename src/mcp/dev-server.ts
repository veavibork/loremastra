#!/usr/bin/env node
/**
 * loremaster.md's "MCP Server (Developer-Facing)" section: exposes live
 * application state to AI coding assistants (Cursor, Claude Code, or
 * similar) working on Loremaster itself, so debugging doesn't mean manually
 * copying state out of a running instance into a chat session. This is a
 * development convenience, not a means of opening LM to third-party MCP
 * clients — it reads the same SQLite files the main server does, directly,
 * rather than going through HTTP, since it's meant to run alongside (or
 * instead of) the running dev server.
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type Database from 'better-sqlite3'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { getGlobalDb } from '../db/global-db.js'
import { notifyDirectMutation } from '../db/session-store.js'
import { listAllStories, getStory } from '../db/story-store.js'
import { getStoryDb, closeStoryDb } from '../db/story-db.js'
import { getStoryState } from '../db/story-state-store.js'
import { getBookByType } from '../db/book-store.js'
import { listWorldbookEntries } from '../db/worldbook-store.js'
import { listRecentJobs } from '../db/job-store.js'
import { getQueueStatus } from '../queue/slots.js'
import { buildLogView } from '../services/log-view.js'
import { readRecentOutboundRequests } from '../inference/outbound-log.js'
import { ensureSingleInstance } from './single-instance.js'
import {
  buildMemoryManifest,
  buildMemorySummary,
  enqueueMemoryPipeline,
  runMemoryBackfill,
} from '../services/memory-manifest.js'
import { findHeadPageId } from '../db/page-store.js'
import { assembleAuthorPrompt } from '../services/history.js'

ensureSingleInstance()

const server = new McpServer({ name: 'loremaster-dev', version: '0.1.0' })

function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

/**
 * This process runs long-lived alongside the dev server purely for one-shot diagnostic reads —
 * unlike the main API server, nothing here benefits from a warm cross-call connection, and
 * getStoryDb() caches its handle indefinitely once opened. Left open, that handle survives in
 * this process even after the main server closes its own and deletes the DB row, which made
 * `DELETE /api/stories/:id` fail with EBUSY on Windows whenever a story had ever been inspected
 * via one of these tools. Closing right after each call keeps this process from accumulating any.
 *
 * skipRecovery: true — this is a read-only diagnostic tool, not the process that claims and
 * executes jobs. Every call here used to run recoverStaleJobs on open, which could reset a job
 * that's genuinely still executing in the main server process back to 'pending', causing it to
 * be reclaimed and re-dispatched mid-flight (found live 2026-07-03 double-submitting a Horde
 * job during routine debugging — see story-db.ts's getStoryDb comment).
 */
function withStoryDb<T>(storyId: string, fn: (db: Database.Database) => T): T {
  const db = getStoryDb(storyId, { skipRecovery: true })
  try {
    return fn(db)
  } finally {
    closeStoryDb(storyId)
  }
}

server.registerTool(
  'list_stories',
  { description: 'List all stories with their id, name, and current phase (setup/kickoff/story).' },
  async () => {
    const globalDb = getGlobalDb()
    const stories = listAllStories(globalDb).map((s) => ({
      id: s.id,
      name: s.name,
      parentStoryId: s.parentStoryId,
      phase: withStoryDb(s.id, (db) => getStoryState(db).phase),
    }))
    return textResult(stories)
  },
)

server.registerTool(
  'get_worldbook',
  {
    description: 'Get all worldbook entries for a story, including hidden ones.',
    inputSchema: { storyId: z.string() },
  },
  async ({ storyId }) =>
    withStoryDb(storyId, (db) => {
      const worldbook = getBookByType(db, 'worldbook')
      if (!worldbook) return textResult({ error: 'no worldbook book for this story' })
      return textResult(listWorldbookEntries(db, worldbook.id, { includeHidden: true }))
    }),
)

server.registerTool(
  'get_queue_status',
  {
    description:
      'Live queue state for a story: recent jobs (any status) plus global concurrency slot usage.',
    inputSchema: { storyId: z.string() },
  },
  async ({ storyId }) =>
    withStoryDb(storyId, (db) => {
      const story = getStory(getGlobalDb(), storyId)
      return textResult({
        slots: story ? getQueueStatus(story.ownerUserId) : null,
        jobs: listRecentJobs(db, 30),
      })
    }),
)

server.registerTool(
  'get_recent_log',
  {
    description: 'Recent log entries (posts) for a story, oldest first, including hidden ones.',
    inputSchema: { storyId: z.string(), limit: z.number().optional() },
  },
  async ({ storyId, limit }) =>
    withStoryDb(storyId, (db) => {
      const logbook = getBookByType(db, 'logbook')
      if (!logbook) return textResult({ error: 'no logbook for this story' })
      const { entries } = buildLogView(db, logbook.id, { limit })
      return textResult(entries)
    }),
)

server.registerTool(
  'tail_dev_server_log',
  {
    description:
      "Tail the running dev server's stdout/stderr log (dev-server.log, written by scripts/dev-restart.mjs).",
    inputSchema: { lines: z.number().optional() },
  },
  async ({ lines }) => {
    const logPath = path.resolve(process.cwd(), 'dev-server.log')
    if (!existsSync(logPath)) return textResult({ error: `${logPath} does not exist` })
    const content = readFileSync(logPath, 'utf-8')
    const allLines = content.split('\n')
    const tail = allLines.slice(-(lines ?? 100)).join('\n')
    return { content: [{ type: 'text' as const, text: tail }] }
  },
)

server.registerTool(
  'get_recent_outbound_requests',
  {
    description:
      'Rolling log of the last outbound chat-completions requests sent to Featherless (model + full messages array), across all stories. For troubleshooting prompt-assembly bugs (e.g. guidance/system messages not reaching the model as expected).',
    inputSchema: { limit: z.number().optional() },
  },
  async ({ limit }) => textResult(readRecentOutboundRequests(limit)),
)

server.registerTool(
  'get_memory_summary',
  {
    description:
      'Compact memory health check: stale compress counts, archive gaps, broken blocks — no full post dump.',
    inputSchema: { storyId: z.string() },
  },
  async ({ storyId }) =>
    withStoryDb(storyId, (db) => {
      const logbook = getBookByType(db, 'logbook')
      if (!logbook) return textResult({ error: 'no logbook for this story' })
      return textResult(buildMemorySummary(db, logbook.id))
    }),
)

server.registerTool(
  'get_prompt_preview',
  {
    description:
      'Assembled Author prompt at the current position (or given page) — read-only, no inference call.',
    inputSchema: { storyId: z.string(), fromPageId: z.string().optional() },
  },
  async ({ storyId, fromPageId }) => {
    const story = getStory(getGlobalDb(), storyId)
    if (!story) return textResult({ error: 'story not found' })

    return withStoryDb(storyId, (db) => {
      const logbook = getBookByType(db, 'logbook')
      if (!logbook) return textResult({ error: 'no logbook for this story' })
      const pageId = fromPageId ?? getStoryState(db).currentPageId ?? findHeadPageId(db, logbook.id)
      if (!pageId) return textResult({ messages: [] })
      return textResult({
        fromPageId: pageId,
        messages: assembleAuthorPrompt(db, story.ownerUserId, logbook.id, pageId),
      })
    })
  },
)

server.registerTool(
  'enqueue_memory_jobs',
  {
    description: 'Queue eligible compress and archive jobs without changing stamps.',
    inputSchema: { storyId: z.string() },
  },
  async ({ storyId }) => {
    const story = getStory(getGlobalDb(), storyId)
    if (!story) return textResult({ error: 'story not found' })

    return withStoryDb(storyId, (db) => {
      const logbook = getBookByType(db, 'logbook')
      if (!logbook) return textResult({ error: 'no logbook for this story' })
      const pending = enqueueMemoryPipeline(db, story.ownerUserId, logbook.id, storyId)
      return textResult({ pendingMemoryJobs: pending, summary: buildMemorySummary(db, logbook.id) })
    })
  },
)

server.registerTool(
  'get_memory_manifest',
  {
    description:
      'Per-post memory diagnostics: content stamps, compress validity, and archive coverage for a story.',
    inputSchema: { storyId: z.string() },
  },
  async ({ storyId }) =>
    withStoryDb(storyId, (db) => {
      const logbook = getBookByType(db, 'logbook')
      if (!logbook) return textResult({ error: 'no logbook for this story' })
      return textResult(buildMemoryManifest(db, logbook.id))
    }),
)

server.registerTool(
  'backfill_memory',
  {
    description:
      'Repair memory pipeline state after direct DB edits or schema upgrades: adopt content stamps ' +
      'and enqueue eligible compress/archive jobs. Call notify_direct_mutation afterward if a browser tab is open.',
    inputSchema: {
      storyId: z.string(),
      enqueueJobs: z.boolean().optional(),
    },
  },
  async ({ storyId, enqueueJobs }) => {
    const story = getStory(getGlobalDb(), storyId)
    if (!story) return textResult({ error: 'story not found' })

    return withStoryDb(storyId, (db) => {
      const logbook = getBookByType(db, 'logbook')
      if (!logbook) return textResult({ error: 'no logbook for this story' })
      return textResult(
        runMemoryBackfill(db, story.ownerUserId, logbook.id, storyId, { enqueueJobs }),
      )
    })
  },
)

server.registerTool(
  'notify_direct_mutation',
  {
    description:
      'Call once after any direct-DB write outside the HTTP API (ad hoc script, manual SQL) that may have changed data ' +
      "an open browser tab is showing. Invalidates the current claimed session so the browser's next request 409s and " +
      'reloads through the normal claim/reclaim flow, instead of silently showing stale state.',
  },
  async () => {
    notifyDirectMutation()
    return textResult({ ok: true })
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
