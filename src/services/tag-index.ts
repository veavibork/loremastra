import type Database from "better-sqlite3";
import { getTag, listTags } from "../db/tag-store.js";
import { addTagMatch, removeTagMatch, listTextIdsForTag } from "../db/tag-index-store.js";
import { getText, listSelectedTextsForBook } from "../db/text-store.js";
import { textForTagMatching } from "./tag-retrieval.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesTag(content: string, tagName: string): boolean {
  const pattern = new RegExp(`\\b${escapeRegExp(tagName)}\\b`, "i");
  return pattern.test(content);
}

/** Tag created or renamed: re-scan every existing post in the book against this one tag (doc: "retroactive grep"). */
export function reindexTagAcrossBook(db: Database.Database, tagId: string): void {
  const tag = getTag(db, tagId);
  if (!tag) return;

  const texts = listSelectedTextsForBook(db, tag.bookId);
  const currentlyMatched = new Set(listTextIdsForTag(db, tagId));
  const nowMatched = new Set<string>();

  for (const text of texts) {
    const haystack = textForTagMatching(text);
    if (!haystack || !matchesTag(haystack, tag.name)) continue;
    nowMatched.add(text.id);
    if (!currentlyMatched.has(text.id)) addTagMatch(db, tagId, text.id);
  }

  for (const textId of currentlyMatched) {
    if (!nowMatched.has(textId)) removeTagMatch(db, tagId, textId);
  }
}

/** New or edited post: scan its verbose and compressed content against every active tag in the book. */
export function indexTextAgainstAllTags(db: Database.Database, bookId: string, textId: string): void {
  const text = getText(db, textId);
  if (!text) return;
  const haystack = textForTagMatching(text);
  if (!haystack) return;

  for (const tag of listTags(db, bookId)) {
    if (tag.hidden) continue;
    if (matchesTag(haystack, tag.name)) {
      addTagMatch(db, tag.id, textId);
    } else {
      removeTagMatch(db, tag.id, textId);
    }
  }
}
