import type Database from "better-sqlite3";
import { listChronologicalPages, type PageRow } from "../db/page-store.js";
import { getText, type TextRole, type TextRow } from "../db/text-store.js";
import { getOwnerArchiveForText, listMemberTextIds, type ArchiveRow } from "../db/archive-store.js";
import { listTagIdsForText, listTextIdsForTag } from "../db/tag-index-store.js";
import { getTag, type TagRow } from "../db/tag-store.js";
import { getBookByType } from "../db/book-store.js";
import { listContentEntries, listWorldbookEntries, type WorldbookEntry } from "../db/worldbook-store.js";
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

interface Line {
  order: number;
  role: TextRole;
  content: string;
  tokens: number;
  kind: "verbose" | "compressed" | "archived";
  refTextId?: string;
  archiveId?: string;
}

/** Renders a worldbook entry as its raw bracket-tagged content — entries have no structured fields or name, just freeform prose. */
function formatWorldbookEntry(entry: WorldbookEntry): string {
  return `[${entry.entryType.toUpperCase()}]\n${entry.content}`;
}

/**
 * Implements the doc's full tiered prompt assembly, steps 3-8 of the Log
 * Compression Pipeline algorithm. Step 3 always-includes the core prompt plus
 * every CONTENT entry (in creation order). Step 4 includes tag-triggered
 * ROSTER/MEMORY entries. Steps 7-8 split trigger tags into "no worldbook
 * entry" vs "has a worldbook entry" and promote using the first group before
 * the second, per the doc's ordering rule (entries already surfaced via step
 * 4 don't need their raw post promoted as urgently as tags with no entry at
 * all — those are the only way that surface area reaches the prompt). Token
 * counting is a chars/4 estimate, not real tokenization.
 */
/**
 * `overrideTagIds`, when passed (even as an empty array), replaces the real trigger-post
 * tag matches entirely — this is what lets the Memory panel simulate "what if these tags
 * were active" independent of actual game state, starting from a true zero-match baseline
 * rather than whatever the last real post happened to match. Real generation calls never
 * pass this, so they're unaffected.
 */
export function assembleAuthorPrompt(
  db: Database.Database,
  logbookId: string,
  fromPageId: string | null,
  overrideTagIds?: string[]
): ChatMessage[] {
  const pages = listChronologicalPages(db, logbookId).filter((p) => !p.hidden);
  const cutoffIdx = fromPageId ? pages.findIndex((p) => p.id === fromPageId) : pages.length - 1;
  const historyPages: PageRow[] = cutoffIdx >= 0 ? pages.slice(0, cutoffIdx + 1) : pages;
  if (!historyPages.length) return [];

  const authorProfile = getAgentProfile("author");
  let remaining = authorProfile.contextLimit - authorProfile.responseLimit;

  // "Tagged" = matches a tag found in the post that's triggering this generation —
  // unless overridden (see doc comment above).
  const triggerText = historyPages[historyPages.length - 1].selectedTextId;
  const triggerTagIds =
    overrideTagIds !== undefined ? overrideTagIds : triggerText ? listTagIdsForText(db, triggerText) : [];

  // Step 3-4: worldbook injection. No worldbook book yet (older test stories, or a
  // story mid-setup) just means these steps contribute nothing — not an error.
  const worldbookHeaderLines: string[] = [];
  const worldbookBook = getBookByType(db, "worldbook");
  let noEntryTagIds: string[] = triggerTagIds;
  let hasEntryTagIds: string[] = [];
  if (worldbookBook) {
    const includedPageIds = new Set<string>();
    for (const entry of listContentEntries(db, worldbookBook.id)) {
      includedPageIds.add(entry.pageId);
      worldbookHeaderLines.push(formatWorldbookEntry(entry));
    }

    // Tag-triggered ROSTER/MEMORY lookup, via the tag_index (pure grep match) rather than
    // any stored pointer — CONTENT is excluded since it's already always-injected above.
    const taggableEntries = listWorldbookEntries(db, worldbookBook.id, { includeHidden: false }).filter(
      (e) => e.entryType !== "content"
    );
    const entryByTextId = new Map(taggableEntries.map((e) => [e.currentTextId, e]));

    const triggerTags = triggerTagIds.map((id) => getTag(db, id)).filter((t): t is TagRow => t !== null);
    noEntryTagIds = [];
    hasEntryTagIds = [];
    for (const tag of triggerTags) {
      const matchedEntry = listTextIdsForTag(db, tag.id)
        .map((textId) => entryByTextId.get(textId))
        .find((e): e is WorldbookEntry => e !== undefined);
      if (matchedEntry) {
        hasEntryTagIds.push(tag.id);
        if (!includedPageIds.has(matchedEntry.pageId)) {
          includedPageIds.add(matchedEntry.pageId);
          worldbookHeaderLines.push(formatWorldbookEntry(matchedEntry));
        }
      } else {
        noEntryTagIds.push(tag.id);
      }
    }
  }
  const worldbookTokens = worldbookHeaderLines.reduce((sum, l) => sum + estimateTokens(l), 0);
  remaining -= worldbookTokens;

  interface Entry {
    order: number;
    text: TextRow | null;
    archive: ArchiveRow | null;
  }
  const entries: Entry[] = historyPages.map((page, order) => {
    const text = page.selectedTextId ? getText(db, page.selectedTextId) : null;
    const archive = text ? getOwnerArchiveForText(db, text.id) : null;
    return { order, text, archive };
  });
  const orderByTextId = new Map(entries.filter((e) => e.text).map((e) => [e.text!.id, e.order]));

  // Step 5: verbose recent window, up to 20% of remaining budget, most recent first.
  const verboseBudget = remaining * 0.2;
  let verboseUsed = 0;
  const verboseTextIds = new Set<string>();
  for (let i = entries.length - 1; i >= 0; i--) {
    const text = entries[i].text;
    if (!text?.genPackage) continue;
    const cost = estimateTokens(text.genPackage);
    if (verboseUsed + cost > verboseBudget) break;
    verboseTextIds.add(text.id);
    verboseUsed += cost;
  }
  remaining -= verboseUsed;

  // Step 6: everything else — archived where an owning block exists (one line per block,
  // deduped), else compressed, else verbose as a last resort so nothing silently vanishes.
  const lines: Line[] = [];
  const seenArchives = new Set<string>();
  for (const { order, text, archive } of entries) {
    if (!text) continue;
    if (verboseTextIds.has(text.id)) {
      lines.push({ order, role: text.role, content: text.genPackage!, tokens: estimateTokens(text.genPackage!), kind: "verbose", refTextId: text.id });
    } else if (archive) {
      if (seenArchives.has(archive.id)) continue;
      seenArchives.add(archive.id);
      const content = archive.summary ?? "(archive pending)";
      lines.push({ order, role: "system", content, tokens: estimateTokens(content), kind: "archived", archiveId: archive.id });
    } else if (text.genExtract != null) {
      lines.push({ order, role: text.role, content: text.genExtract, tokens: estimateTokens(text.genExtract), kind: "compressed", refTextId: text.id });
    } else if (text.genPackage) {
      lines.push({ order, role: text.role, content: text.genPackage, tokens: estimateTokens(text.genPackage), kind: "verbose", refTextId: text.id });
    }
  }

  function collectTaggedTextIds(tagIds: string[]): Set<string> {
    const set = new Set<string>();
    for (const tagId of tagIds) for (const textId of listTextIdsForTag(db, tagId)) set.add(textId);
    return set;
  }

  // Step 7: most-recent-to-least-recent archive blocks — if a block has a tagged member, swap
  // the one archive line for that block's individual compressed rows, budget permitting.
  function promoteArchives(taggedSet: Set<string>): void {
    const archiveLines = lines.filter((l) => l.kind === "archived").sort((a, b) => b.order - a.order);
    for (const archiveLine of archiveLines) {
      const memberTextIds = listMemberTextIds(db, archiveLine.archiveId!);
      if (!memberTextIds.some((id) => taggedSet.has(id))) continue;

      const replacements: Line[] = [];
      let replacementCost = 0;
      for (const textId of memberTextIds) {
        const t = getText(db, textId);
        if (!t?.genExtract) continue;
        const order = orderByTextId.get(textId);
        if (order == null) continue;
        const tokens = estimateTokens(t.genExtract);
        replacements.push({ order, role: t.role, content: t.genExtract, tokens, kind: "compressed", refTextId: t.id });
        replacementCost += tokens;
      }
      if (replacementCost - archiveLine.tokens > remaining) continue;
      remaining -= replacementCost - archiveLine.tokens;
      lines.splice(lines.indexOf(archiveLine), 1, ...replacements);
    }
  }

  // Step 8: most-recent-to-least-recent compressed rows — if tagged, swap for verbose, budget permitting.
  function promoteCompressed(taggedSet: Set<string>): void {
    const compressedLines = lines.filter((l) => l.kind === "compressed").sort((a, b) => b.order - a.order);
    for (const line of compressedLines) {
      if (!line.refTextId || !taggedSet.has(line.refTextId)) continue;
      const t = getText(db, line.refTextId);
      if (!t?.genPackage) continue;
      const verboseCost = estimateTokens(t.genPackage);
      if (verboseCost - line.tokens > remaining) continue;
      remaining -= verboseCost - line.tokens;
      const idx = lines.indexOf(line);
      lines[idx] = { ...line, content: t.genPackage, tokens: verboseCost, kind: "verbose" };
    }
  }

  // Doc's ordering rule: tags with no worldbook entry are evaluated before tags that
  // already have one — an entry surfaced via step 4 doesn't need its raw post promoted
  // as urgently, since some of that information is already in the prompt.
  const noEntryTaggedTextIds = collectTaggedTextIds(noEntryTagIds);
  const hasEntryTaggedTextIds = collectTaggedTextIds(hasEntryTagIds);
  promoteArchives(noEntryTaggedTextIds);
  promoteArchives(hasEntryTaggedTextIds);
  promoteCompressed(noEntryTaggedTextIds);
  promoteCompressed(hasEntryTaggedTextIds);

  lines.sort((a, b) => a.order - b.order);
  const worldbookMessages: ChatMessage[] = worldbookHeaderLines.map((content) => ({ role: "system", content }));
  return [
    { role: "system", content: AUTHOR_SYSTEM_PROMPT },
    ...worldbookMessages,
    ...lines.map((l) => ({ role: toChatRole(l.role), content: l.content })),
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
