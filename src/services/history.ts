import type Database from "better-sqlite3";
import { listChronologicalPages, type PageRow } from "../db/page-store.js";
import { getText, type TextRole, type TextRow } from "../db/text-store.js";
import { listArchivesForBook, listMemberTextIds } from "../db/archive-store.js";
import { getBookByType } from "../db/book-store.js";
import { listWorldbookEntries, listContentEntries, type WorldbookEntry } from "../db/worldbook-store.js";
import type { ChatMessage } from "../inference/featherless.js";
import { getAgentProfile } from "./agent-config.js";
import { AUTHOR_SYSTEM_PROMPT, AUTHOR_KICKOFF_PROMPT } from "../prompts.js";

// No real tokenizer wired up yet (Featherless exposes /v1/tokenize — see
// docs/featherless-notes.md — not yet used). This is a rough approximation,
// good enough to budget by, not to rely on for precision.
const CHARS_PER_TOKEN_ESTIMATE = 4;
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

function toChatRole(role: TextRole): "user" | "assistant" | "system" {
  if (role === "agent") return "assistant";
  if (role === "system") return "system";
  return "user";
}

/** Renders a worldbook entry as its raw bracket-tagged content — entries have no structured fields or name, just freeform prose. */
function formatWorldbookEntry(entry: WorldbookEntry): string {
  return `[${entry.entryType.toUpperCase()}]\n${entry.content}`;
}

export function formatEventSummary(summary: string): string {
  return `[EVENT SUMMARY]\n${summary.trim()}\n[/EVENT SUMMARY]`;
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

  const authorProfile = getAgentProfile(userId, "author");
  let remaining = authorProfile.contextLimit - authorProfile.responseLimit;

  const worldbookHeaderLines: string[] = [];
  const worldbookBook = getBookByType(db, "worldbook");
  if (worldbookBook) {
    for (const entry of listWorldbookEntries(db, worldbookBook.id, { includeHidden: false })) {
      worldbookHeaderLines.push(formatWorldbookEntry(entry));
    }
  }
  remaining -= worldbookHeaderLines.reduce((sum, l) => sum + estimateTokens(l), 0);

  interface HistoryEntry {
    order: number;
    text: TextRow;
  }
  const entries: HistoryEntry[] = [];
  for (let order = 0; order < historyPages.length; order++) {
    const page = historyPages[order]!;
    if (!page.selectedTextId) continue;
    const text = getText(db, page.selectedTextId);
    if (!text?.genPackage?.trim()) continue;
    entries.push({ order, text });
  }

  // Pass 1: fill from the recent end with full verbose prose.
  const verboseTextIds = new Set<string>();
  let verboseUsed = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const text = entries[i]!.text;
    const cost = estimateTokens(text.genPackage!);
    if (verboseUsed + cost > remaining) break;
    verboseTextIds.add(text.id);
    verboseUsed += cost;
  }
  remaining -= verboseUsed;

  const pageIndexOf = new Map(historyPages.map((p, i) => [p.id, i]));
  const archiveRows = listArchivesForBook(db, logbookId)
    .filter((a) => a.summary?.trim() && !a.broken)
    .map((a) => ({
      archive: a,
      startIdx: pageIndexOf.get(a.startPageId) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => a.startIdx - b.startIdx);

  const archiveCoveredTextIds = new Set<string>();
  const eventSummaries: ChatMessage[] = [];

  // Pass 2: oldest-first archive blocks for posts not already verbose.
  for (const { archive } of archiveRows) {
    const memberIds = listMemberTextIds(db, archive.id);
    const coversUncovered = memberIds.some((id) => !verboseTextIds.has(id));
    if (!coversUncovered) continue;

    const content = formatEventSummary(archive.summary!);
    const cost = estimateTokens(content);
    if (cost > remaining) break;

    remaining -= cost;
    eventSummaries.push({ role: "system", content });
    for (const id of memberIds) archiveCoveredTextIds.add(id);
  }

  // Pass 3: if budget remains, pull more verbose from recent among still-uncovered posts.
  for (let i = entries.length - 1; i >= 0; i--) {
    const text = entries[i]!.text;
    if (verboseTextIds.has(text.id) || archiveCoveredTextIds.has(text.id)) continue;
    const cost = estimateTokens(text.genPackage!);
    if (cost > remaining) break;
    verboseTextIds.add(text.id);
    remaining -= cost;
  }

  const verboseMessages: ChatMessage[] = entries
    .filter((e) => verboseTextIds.has(e.text.id))
    .sort((a, b) => a.order - b.order)
    .map((e) => ({ role: toChatRole(e.text.role), content: e.text.genPackage! }));

  const worldbookMessages: ChatMessage[] = worldbookHeaderLines.map((content) => ({ role: "system", content }));
  return [
    { role: "system", content: AUTHOR_SYSTEM_PROMPT },
    ...worldbookMessages,
    ...eventSummaries,
    ...verboseMessages,
  ];
}

/**
 * Kickoff's opening post is generated from the worldbook alone — no log
 * history — deliberately: the setup conversation that produced the
 * worldbook is a design discussion between the user and the Editor, not
 * narrative, and folding it into the Author's context here would leak
 * meta-conversation into the story.
 */
export function assembleKickoffPrompt(db: Database.Database, worldbookBookId: string): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: AUTHOR_SYSTEM_PROMPT }];
  for (const entry of listContentEntries(db, worldbookBookId)) {
    messages.push({ role: "system", content: formatWorldbookEntry(entry) });
  }
  messages.push({ role: "system", content: AUTHOR_KICKOFF_PROMPT });
  return messages;
}
