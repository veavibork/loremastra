import type Database from "better-sqlite3";
import { listTags } from "../db/tag-store.js";
import { getText, type TextRow } from "../db/text-store.js";
import type { PageRow } from "../db/page-store.js";

const RECENT_ASSISTANT_CONTEXT = 2;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesTagInText(content: string, tagName: string): boolean {
  const pattern = new RegExp(`\\b${escapeRegExp(tagName)}\\b`, "i");
  return pattern.test(content);
}

/**
 * KAI-style query activation: match tag cloud against the latest user message plus
 * a few recent assistant turns — not only the trigger post's verbatim grep.
 */
export function buildTagQueryText(db: Database.Database, historyPages: PageRow[]): string {
  if (!historyPages.length) return "";

  const parts: string[] = [];
  let assistantsSeen = 0;

  for (let i = historyPages.length - 1; i >= 0; i--) {
    const page = historyPages[i]!;
    const text = page.selectedTextId ? getText(db, page.selectedTextId) : null;
    if (!text?.genPackage) continue;

    if (i === historyPages.length - 1) {
      parts.unshift(text.genPackage);
      continue;
    }

    if (text.role === "agent" && assistantsSeen < RECENT_ASSISTANT_CONTEXT) {
      parts.unshift(text.genPackage);
      assistantsSeen++;
    }
  }

  return parts.join("\n");
}

/** Active tags whose name appears in the query text (word-boundary grep). */
export function activateTagsFromQuery(db: Database.Database, bookId: string, queryText: string): string[] {
  if (!queryText.trim()) return [];

  const matched: string[] = [];
  for (const tag of listTags(db, bookId)) {
    if (tag.hidden) continue;
    if (matchesTagInText(queryText, tag.name)) matched.push(tag.id);
  }
  return matched;
}

/** Text fields that participate in tag indexing and promotion matching. */
export function textForTagMatching(text: TextRow): string {
  const parts = [text.genPackage, text.genExtract].filter((s): s is string => !!s?.trim());
  return parts.join("\n");
}
