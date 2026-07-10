import type Database from "better-sqlite3";
import { getBookByType } from "../db/book-store.js";
import { createJob, hasActiveWorldbookCompactJob, type JobRow } from "../db/job-store.js";
import { getDecryptedFeatherlessKey } from "../db/user-store.js";
import { getGlobalDb } from "../db/global-db.js";
import {
  listWorldbookEntries,
  updateWorldbookEntry,
  type WorldbookEntry,
  type WorldbookEntryType,
} from "../db/worldbook-store.js";
import { completeChat, type ChatMessage } from "../inference/featherless.js";
import { WORLDBOOK_COMPACT_SYSTEM_PROMPT } from "../prompts.js";
import { getAgentProfile } from "./agent-config.js";
import { estimateTokens } from "./story-to-date-corpus.js";

export interface WorldbookCompactOpts {
  entryType?: WorldbookEntryType;
  includeHidden?: boolean;
}

const worldbookCompactJobOpts = new Map<string, WorldbookCompactOpts>();

export function setWorldbookCompactJobOpts(jobId: string, opts: WorldbookCompactOpts): void {
  worldbookCompactJobOpts.set(jobId, opts);
}

export function takeWorldbookCompactJobOpts(jobId: string): WorldbookCompactOpts {
  const opts = worldbookCompactJobOpts.get(jobId) ?? {};
  worldbookCompactJobOpts.delete(jobId);
  return opts;
}

export interface WorldbookCompactEntryResult {
  pageId: string;
  entryType: WorldbookEntryType;
  beforeTokens: number;
  afterTokens: number;
  skipped: boolean;
}

export interface WorldbookCompactResult {
  entries: WorldbookCompactEntryResult[];
  totalBeforeTokens: number;
  totalAfterTokens: number;
}

function buildCompactUserPrompt(entry: WorldbookEntry): string {
  return `Entry type: ${entry.entryType.toUpperCase()}

Worldbook entry to compact:
${entry.content}`;
}

async function compactEntryContent(
  editor: ReturnType<typeof getAgentProfile>,
  apiKey: string,
  entry: WorldbookEntry
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: WORLDBOOK_COMPACT_SYSTEM_PROMPT },
    { role: "user", content: buildCompactUserPrompt(entry) },
  ];
  return (await completeChat(editor, apiKey, messages, { maxTokens: editor.responseLimit })).trim();
}

/**
 * Compact every visible worldbook entry in place — one Editor call per entry.
 * Previously experiment-only (`scripts/worldbook-compact-experiment.ts`); not automatic.
 */
export async function compactStoryWorldbook(
  db: Database.Database,
  userId: string,
  opts: { entryType?: WorldbookEntryType; includeHidden?: boolean } = {}
): Promise<WorldbookCompactResult> {
  const worldbook = getBookByType(db, "worldbook");
  if (!worldbook) throw new Error("worldbook not found");

  const apiKey = getDecryptedFeatherlessKey(getGlobalDb(), userId);
  if (!apiKey) throw new Error("no Featherless API key configured");

  const editor = getAgentProfile(userId, "editor");
  const entries = listWorldbookEntries(db, worldbook.id, {
    includeHidden: opts.includeHidden ?? false,
  }).filter((e) => !opts.entryType || e.entryType === opts.entryType);

  const results: WorldbookCompactEntryResult[] = [];
  let totalBeforeTokens = 0;
  let totalAfterTokens = 0;

  for (const entry of entries) {
    const beforeTokens = estimateTokens(entry.content);
    totalBeforeTokens += beforeTokens;

    if (!entry.content.trim()) {
      results.push({
        pageId: entry.pageId,
        entryType: entry.entryType,
        beforeTokens,
        afterTokens: beforeTokens,
        skipped: true,
      });
      totalAfterTokens += beforeTokens;
      continue;
    }

    const compacted = await compactEntryContent(editor, apiKey, entry);
    if (!compacted) {
      results.push({
        pageId: entry.pageId,
        entryType: entry.entryType,
        beforeTokens,
        afterTokens: beforeTokens,
        skipped: true,
      });
      totalAfterTokens += beforeTokens;
      continue;
    }

    updateWorldbookEntry(db, entry.pageId, { content: compacted });
    const afterTokens = estimateTokens(compacted);
    totalAfterTokens += afterTokens;
    results.push({
      pageId: entry.pageId,
      entryType: entry.entryType,
      beforeTokens,
      afterTokens,
      skipped: false,
    });
  }

  return { entries: results, totalBeforeTokens, totalAfterTokens };
}

/** Enqueue a worldbook-compact job — one Editor call per entry, executed on the worker lane. */
export function enqueueWorldbookCompactJob(
  db: Database.Database,
  userId: string,
  opts: WorldbookCompactOpts = {}
): JobRow {
  if (hasActiveWorldbookCompactJob(db)) {
    throw new Error("worldbook crunch already in progress");
  }

  const worldbook = getBookByType(db, "worldbook");
  if (!worldbook) throw new Error("worldbook not found");

  const entries = listWorldbookEntries(db, worldbook.id, {
    includeHidden: opts.includeHidden ?? false,
  }).filter((e) => !opts.entryType || e.entryType === opts.entryType);
  if (!entries.length) throw new Error("no worldbook entries to compact");

  const job = createJob(db, {
    targetTextId: entries[0]!.currentTextId,
    jobType: "worldbook-compact",
    slotCost: getAgentProfile(userId, "editor").concurrencyCost,
    priority: 0,
  });
  setWorldbookCompactJobOpts(job.id, opts);
  return job;
}
