import type Database from "better-sqlite3";
import { getTag, listTags, setTagWorldbookPage, type TagRow } from "../db/tag-store.js";
import { addTagMatch, removeTagMatch, listTextIdsForTag } from "../db/tag-index-store.js";
import { getText, listSelectedTextsForBook } from "../db/text-store.js";
import { listWorldbookEntries, type WorldbookEntry } from "../db/worldbook-store.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesTag(content: string, tagName: string): boolean {
  const pattern = new RegExp(`\\b${escapeRegExp(tagName)}\\b`, "i");
  return pattern.test(content);
}

/**
 * Auto-attaches a tag to the worldbook entry it names, via the same grep matching already
 * used for post indexing — the Lore UI's manual dropdown exists for the exceptions (no name
 * match, or deliberately pointing it elsewhere), not the normal path. Never overrides an
 * existing attachment, whether it got there manually or automatically.
 */
export function autoLinkTagToEntry(db: Database.Database, worldbookBookId: string, tag: TagRow): void {
  if (tag.worldbookPageId) return;
  const entries = listWorldbookEntries(db, worldbookBookId, { includeHidden: true });
  const match = entries.find((entry) => matchesTag(entry.name, tag.name));
  if (match) setTagWorldbookPage(db, tag.id, match.pageId);
}

/** Reverse direction: a worldbook entry was just created or renamed — link any existing unattached tag that names it. */
export function autoLinkEntryToTags(db: Database.Database, tagScopeBookId: string, entry: WorldbookEntry): void {
  const unattached = listTags(db, tagScopeBookId).filter((t) => !t.worldbookPageId);
  const match = unattached.find((tag) => matchesTag(entry.name, tag.name));
  if (match) setTagWorldbookPage(db, match.id, entry.pageId);
}

/** Tag created or renamed: re-scan every existing post in the book against this one tag (doc: "retroactive grep"). */
export function reindexTagAcrossBook(db: Database.Database, tagId: string): void {
  const tag = getTag(db, tagId);
  if (!tag) return;

  const texts = listSelectedTextsForBook(db, tag.bookId);
  const currentlyMatched = new Set(listTextIdsForTag(db, tagId));
  const nowMatched = new Set<string>();

  for (const text of texts) {
    if (!text.genPackage || !matchesTag(text.genPackage, tag.name)) continue;
    nowMatched.add(text.id);
    if (!currentlyMatched.has(text.id)) addTagMatch(db, tagId, text.id);
  }

  for (const textId of currentlyMatched) {
    if (!nowMatched.has(textId)) removeTagMatch(db, tagId, textId);
  }
}

/** New or edited post: scan its content against every active tag in the book. */
export function indexTextAgainstAllTags(db: Database.Database, bookId: string, textId: string): void {
  const text = getText(db, textId);
  if (!text || !text.genPackage) return;

  for (const tag of listTags(db, bookId)) {
    if (tag.hidden) continue;
    if (matchesTag(text.genPackage, tag.name)) {
      addTagMatch(db, tag.id, textId);
    } else {
      removeTagMatch(db, tag.id, textId);
    }
  }
}
