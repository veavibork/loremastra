import type Database from "better-sqlite3";
import { getBookByType } from "../db/book-store.js";
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
