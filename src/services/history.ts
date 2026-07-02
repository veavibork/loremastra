import type Database from "better-sqlite3";
import { listChronologicalPages, type PageRow } from "../db/page-store.js";
import { getText, type TextRole, type TextRow } from "../db/text-store.js";
import { getOwnerArchiveForText, listMemberTextIds, type ArchiveRow } from "../db/archive-store.js";
import { listTagIdsForText, listTextIdsForTag } from "../db/tag-index-store.js";
import { getTag, type TagRow } from "../db/tag-store.js";
import { getBookByType } from "../db/book-store.js";
import {
  getPcEntry,
  getSingletonEntry,
  getWorldbookEntry,
  WORLDBOOK_FIELD_SCHEMAS,
  type WorldbookEntry,
} from "../db/worldbook-store.js";
import type { ChatMessage } from "../inference/featherless.js";
import { getAgentProfile } from "./agent-config.js";

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

/** Renders a worldbook entry the same way the doc's own example NPC entry is formatted (Tags: ... / Label: value). */
function formatWorldbookEntry(entry: WorldbookEntry, tagNames: string[]): string {
  const schema = WORLDBOOK_FIELD_SCHEMAS[entry.entryType];
  const lines = [`[${entry.entryType}${entry.isPc ? " - PC" : ""}] ${entry.name}`];
  if (tagNames.length) lines.push(`Tags: ${tagNames.join(", ")}`);
  for (const { key, label } of schema) {
    const value = entry.fields[key];
    if (value) lines.push(`${label}: ${value}`);
  }
  return lines.join("\n");
}

function tagNamesForEntry(db: Database.Database, worldbookBookId: string, pageId: string): string[] {
  // Tags don't reference a book directly, but every tag pointing at this page belongs to
  // the story's tag scope regardless of book id — a simple lookup by worldbook_page_id.
  const rows = db.prepare(`SELECT name FROM tags WHERE worldbook_page_id = ?`).all(pageId) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/**
 * The Author's core identity/rules. Combines lorepebble's st2.json GM prompt
 * (three jobs, PC-action boundaries, worldbook usage rules, pacing/voice
 * craft) with three ideas from Alex's improv/social-contract notes: the
 * user/player/character layering (LLMs conflate "the user" with "the PC" and
 * inherit obedience instincts toward them), the yes-and/no-but improv
 * contract, and "but, therefore" causal structure over flat "and then" event
 * chains. PC address deliberately kept as st2.json's existing 2nd-person
 * convention — an open question pending real play-testing, see
 * docs/stub-revisions.md.
 */
export const AUTHOR_SYSTEM_PROMPT = `You are the Game Master for the player's solo roleplay session. Three jobs at once:
narrating what the player perceives, voicing every NPC with distinct wants and reactions,
and tracking what's happening in the world beyond what's directly seen — how it shifts in
response to what the player does.

You don't narrate the player's thoughts, feelings, intentions, or actions. They write their
own character. You write everything else. If they say "I approach the door," describe what
they see and hear — not how they approached, and never what they're thinking or feeling
while doing it.

Carry the scene forward from where the last moment ended. End at a moment that invites the
next action — a question hanging unanswered, a half-finished gesture, a sound that just
resolved. The scene asks the player to act; you don't have to.

THREE LAYERS, ONE PLAYER

The person you're responding to occupies three roles, and they are not the same:

- As a USER, they get obeyed. Out-of-character requests — pacing, formatting, content
  limits — are instructions.
- As a PLAYER, their character's actions are a move in a scene, not a command. Respond
  like an improv scene partner: extend what earns it ("yes, and—"), complicate what needs
  tension ("no, but—"). Challenge them. Take the story somewhere they didn't ask for. A GM
  who always gives the player what they asked for isn't running a game.
- As a CHARACTER (their PC), they have real narrative weight but no special immunity. NPCs
  can disagree with them, dislike them, refuse them, act against them — exactly as they
  would against anyone else in the fiction — unless the Content Register says otherwise.
  Don't let any instinct to please the user leak into how the world treats their PC.

BUT, THEREFORE — NOT AND, THEN

Scenes built from "this happened, and then that happened" go flat. Build causally: this
happens, BUT [complication], THEREFORE [consequence]. Every beat should follow from what
came before, not just sit next to it.

WORLDBOOK ENTRIES

Structured information about the world comes to you through worldbook entries. Treat them
as authoritative. NPC entries describe individuals — use them for the character and for
inferring how they'd react to situations they don't directly cover. Location entries
describe places. Faction entries describe organized groups. Creature entries include
explicit "do not" rails — read them; the point is that non-human minds shouldn't think or
speak like small humans. Role entries cover generic members of a type (the unnamed
librarian); a named NPC entry overrides a Role entry for that individual. Setting entries
flavor everything. Content Register defines what content space the game occupies — stay
inside it.

Where an entry contains a secret, you know it; the player doesn't. NPCs reveal information
through behavior, slip-ups, or earned trust — never narrator exposition.

You can invent details to fill unspecified gaps — a face in a crowd, an unmapped room's
layout, weather. You can't invent major developments that override the worldbook or trap
the player somewhere they can't escape. The worldbook is the spine; your improvisation
fleshes it out, doesn't rewrite it.

CRAFT

Scenes have shape — sensory opening, development through choice and consequence, close
when a decision lands or a moment resolves. Don't extend a scene past its natural end.
Response length matches the weight of the moment: a glance across a room is a sentence or
two; a confrontation earns more. When in doubt, write less. Reach for the specific over the
generic — the bartender wipes a glass that's already clean, not "a tough-looking
bartender." NPCs sound like who they are; a dwarf miner and an elven priestess don't share
a voice. Broken Common, alien syntax, and accents live only inside that character's quoted
dialogue — your narration voice stays clean regardless of who's been talking.

Tone is calibrated by the Setting entry and Content Register. Within whatever those
establish: the world existed before the player arrived and continues without them. NPCs
have lives, not quest-dispensers.`;

/**
 * Implements the doc's full tiered prompt assembly, steps 3-8 of the Log
 * Compression Pipeline algorithm. Step 3 always-includes the core prompt plus
 * Register/Setting/PC. Step 4 includes tag-triggered worldbook entries. Steps
 * 7-8 split trigger tags into "no worldbook entry" vs "has a worldbook entry"
 * and promote using the first group before the second, per the doc's
 * ordering rule (entries already surfaced via step 4 don't need their raw
 * post promoted as urgently as tags with no entry at all — those are the
 * only way that surface area reaches the prompt). Token counting is a
 * chars/4 estimate, not real tokenization.
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
    const setting = getSingletonEntry(db, worldbookBook.id, "setting");
    const register = getSingletonEntry(db, worldbookBook.id, "register");
    const pc = getPcEntry(db, worldbookBook.id);
    for (const entry of [register, setting, pc]) {
      if (!entry) continue;
      includedPageIds.add(entry.pageId);
      worldbookHeaderLines.push(formatWorldbookEntry(entry, tagNamesForEntry(db, worldbookBook.id, entry.pageId)));
    }

    const triggerTags = triggerTagIds.map((id) => getTag(db, id)).filter((t): t is TagRow => t !== null);
    // The PC tag (whichever tag(s) point at the PC entry) is excluded from the
    // expansion/promotion priority loop — the PC entry is already always-included
    // and would otherwise dominate the budget since nearly every post mentions the PC.
    const pcPageId = pc?.pageId ?? null;
    const eligibleTags = triggerTags.filter((t) => t.worldbookPageId !== pcPageId);
    noEntryTagIds = eligibleTags.filter((t) => !t.worldbookPageId).map((t) => t.id);
    hasEntryTagIds = eligibleTags.filter((t) => t.worldbookPageId).map((t) => t.id);

    for (const tag of eligibleTags) {
      if (!tag.worldbookPageId || includedPageIds.has(tag.worldbookPageId)) continue;
      const entry = getWorldbookEntry(db, tag.worldbookPageId);
      if (!entry || entry.hidden) continue;
      includedPageIds.add(entry.pageId);
      worldbookHeaderLines.push(formatWorldbookEntry(entry, tagNamesForEntry(db, worldbookBook.id, entry.pageId)));
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

export const KICKOFF_INSTRUCTION =
  "Generate the opening post for this story based on the worldbook above. Write in the register and " +
  "voice described. End at a natural moment that invites the player to act.";

/**
 * Kickoff's opening post is generated from the worldbook alone — no log
 * history — deliberately: the setup conversation that produced the
 * worldbook is a design discussion between the user and the Editor, not
 * narrative, and folding it into the Author's context here would leak
 * meta-conversation into the story.
 */
export function assembleKickoffPrompt(db: Database.Database, worldbookBookId: string): ChatMessage[] {
  const setting = getSingletonEntry(db, worldbookBookId, "setting");
  const register = getSingletonEntry(db, worldbookBookId, "register");
  const pc = getPcEntry(db, worldbookBookId);

  const messages: ChatMessage[] = [{ role: "system", content: AUTHOR_SYSTEM_PROMPT }];
  for (const entry of [register, setting, pc]) {
    if (!entry) continue;
    messages.push({ role: "system", content: formatWorldbookEntry(entry, tagNamesForEntry(db, worldbookBookId, entry.pageId)) });
  }
  messages.push({ role: "system", content: KICKOFF_INSTRUCTION });
  return messages;
}
