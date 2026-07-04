import type Database from "better-sqlite3";
import { listChronologicalPages, type PageRow } from "../db/page-store.js";
import { getText, type TextRole, type TextRow } from "../db/text-store.js";
import { getBookByType } from "../db/book-store.js";
import { listWorldbookEntries, listContentEntries, type WorldbookEntry } from "../db/worldbook-store.js";
import { getStoryState } from "../db/story-state-store.js";
import { listStoryToDateSegments } from "../db/story-to-date-store.js";
import type { ChatMessage } from "../inference/featherless.js";
import { getAgentProfile } from "./agent-config.js";
import { AUTHOR_SYSTEM_PROMPT, AUTHOR_KICKOFF_PROMPT } from "../prompts.js";
import { mergeStoryToDate } from "./story-to-date-corpus.js";

const CHARS_PER_TOKEN_ESTIMATE = 4;
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

function toChatRole(role: TextRole): "user" | "assistant" | "system" {
  if (role === "agent") return "assistant";
  if (role === "system") return "system";
  return "user";
}

function formatWorldbookEntry(entry: WorldbookEntry): string {
  return `[${entry.entryType.toUpperCase()}]\n${entry.content}`;
}

export function assembleAuthorPrompt(
  db: Database.Database,
  userId: string,
  logbookId: string,
  fromPageId: string | null
): ChatMessage[] {
  const pages = listChronologicalPages(db, logbookId).filter((p) => !p.hidden);
  const cutoffIdx = fromPageId ? pages.findIndex((p) => p.id === fromPageId) : pages.length - 1;
  const historyPages: PageRow[] = cutoffIdx >= 0 ? pages.slice(0, cutoffIdx + 1) : pages;
  if (!historyPages.length) return [];

  const worldbookHeaderLines: string[] = [];
  const worldbookBook = getBookByType(db, "worldbook");
  if (worldbookBook) {
    for (const entry of listWorldbookEntries(db, worldbookBook.id, { includeHidden: false })) {
      worldbookHeaderLines.push(formatWorldbookEntry(entry));
    }
  }

  const readySegments = listStoryToDateSegments(db, logbookId).filter((s) => s.content?.trim() && !s.broken);
  const storyToDateBlock = mergeStoryToDate(
    readySegments.map((s) => ({
      kind: s.kind,
      content: s.content!.trim(),
      coverageThroughPost: s.coverageThroughIcPost ?? 0,
      coveragePageId: s.coveragePageId,
    }))
  );

  let afterOrder = -1;
  const lastSegment = readySegments.sort((a, b) => b.seq - a.seq)[0];
  if (lastSegment?.coveragePageId) {
    const idx = historyPages.findIndex((p) => p.id === lastSegment.coveragePageId);
    if (idx >= 0) afterOrder = idx;
  }

  const state = getStoryState(db);
  const kickoffOrder = state.kickoffPageId
    ? historyPages.findIndex((p) => p.id === state.kickoffPageId)
    : -1;

  interface HistoryEntry {
    order: number;
    text: TextRow;
  }
  const entries: HistoryEntry[] = [];
  for (let order = 0; order < historyPages.length; order++) {
    const page = historyPages[order]!;
    if (kickoffOrder >= 0 && order < kickoffOrder) continue;
    if (order <= afterOrder) continue;
    if (!page.selectedTextId) continue;
    const text = getText(db, page.selectedTextId);
    if (!text?.genPackage?.trim()) continue;
    entries.push({ order, text });
  }

  const verboseMessages: ChatMessage[] = entries
    .sort((a, b) => a.order - b.order)
    .map((e) => ({ role: toChatRole(e.text.role), content: e.text.genPackage! }));

  const worldbookMessages: ChatMessage[] = worldbookHeaderLines.map((content) => ({ role: "system", content }));
  const storyToDateMessages: ChatMessage[] = storyToDateBlock
    ? [{ role: "system", content: storyToDateBlock }]
    : [];

  return [
    { role: "system", content: AUTHOR_SYSTEM_PROMPT },
    ...worldbookMessages,
    ...storyToDateMessages,
    ...verboseMessages,
  ];
}

export function assembleKickoffPrompt(db: Database.Database, worldbookBookId: string): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: AUTHOR_SYSTEM_PROMPT }];
  for (const entry of listContentEntries(db, worldbookBookId)) {
    messages.push({ role: "system", content: formatWorldbookEntry(entry) });
  }
  messages.push({ role: "system", content: AUTHOR_KICKOFF_PROMPT });
  return messages;
}

/** Exported for story-to-date trigger estimation. */
export { estimateTokens };
