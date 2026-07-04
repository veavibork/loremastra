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

export function formatEventSummary(summary: string, sceneName?: string | null): string {
  const trimmed = summary.trim();
  if (sceneName?.trim()) {
    return `[EVENT SUMMARY: ${sceneName.trim()}]\n${trimmed}\n[/EVENT SUMMARY]`;
  }
  return `[EVENT SUMMARY]\n${trimmed}\n[/EVENT SUMMARY]`;
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

  const historyBudget = remaining;

  // Pass 1: start with all history as full verbose prose.
  const verboseTextIds = new Set<string>();
  let historyCost = 0;
  for (const entry of entries) {
    verboseTextIds.add(entry.text.id);
    historyCost += estimateTokens(entry.text.genPackage!);
  }

  const pageIndexOf = new Map(historyPages.map((p, i) => [p.id, i]));
  const archiveRows = listArchivesForBook(db, logbookId)
    .filter((a) => a.summary?.trim() && !a.broken)
    .map((a) => ({
      archive: a,
      startIdx: pageIndexOf.get(a.startPageId) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => a.startIdx - b.startIdx);

  const eventSummaries: ChatMessage[] = [];

  // Pass 2: when over budget, walk oldest-first archives and swap member verbose for summaries.
  if (historyCost > historyBudget) {
    for (const { archive } of archiveRows) {
      if (historyCost <= historyBudget) break;

      const memberIds = listMemberTextIds(db, archive.id);
      const flipIds = memberIds.filter((id) => verboseTextIds.has(id));
      if (flipIds.length === 0) continue;

      const content = formatEventSummary(archive.summary!, archive.name);
      const summaryCost = estimateTokens(content);

      let verboseCost = 0;
      for (const id of flipIds) {
        const entry = entries.find((e) => e.text.id === id);
        if (entry) verboseCost += estimateTokens(entry.text.genPackage!);
      }

      const savings = verboseCost - summaryCost;
      if (savings <= 0) continue;

      for (const id of flipIds) verboseTextIds.delete(id);
      historyCost -= savings;
      eventSummaries.push({ role: "system", content });
    }
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
