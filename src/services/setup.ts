import type Database from "better-sqlite3";
import { callWithTools, withModelFallback, type ChatMessage, type ToolDefinition } from "../inference/featherless.js";
import { getAgentProfile } from "./agent-config.js";
import {
  createWorldbookEntry,
  listWorldbookEntries,
  updateWorldbookEntry,
  WORLDBOOK_FIELD_SCHEMAS,
  type WorldbookEntry,
  type WorldbookEntryType,
} from "../db/worldbook-store.js";
import { createTag, isValidTagName, listTags, setTagWorldbookPage } from "../db/tag-store.js";
import { reindexTagAcrossBook } from "./tag-index.js";

const ENTRY_TYPES: WorldbookEntryType[] = ["setting", "register", "location", "creature", "faction", "character"];

// Shows both the exact JSON key and the human label — models otherwise mirror the label's
// casing/wording back as the key (e.g. "Off the table" instead of "offTable"), which then
// fails to match anywhere the schema key is looked up. See normalizeFields for the backstop.
function describeSchemas(): string {
  return (Object.entries(WORLDBOOK_FIELD_SCHEMAS) as [WorldbookEntryType, { key: string; label: string }[]][])
    .map(([type, fields]) => `- ${type}: ${fields.map((f) => `${f.key} (${f.label})`).join(", ")}`)
    .join("\n");
}

/** Original prompt (not lorepebble's st1.json verbatim), but drawing on the same shop-talk approach it validated: follow the user's lead, one or two focused questions per turn, call the tool as soon as there's enough for an entry rather than waiting for the whole conversation to finish. */
const EDITOR_SETUP_SYSTEM_PROMPT = `You are the Editor, running the setup conversation for a new roleplay story.

Your job is collaborative worldbuilding, not an interview. Follow the user's lead — if they hand you a genre and a character idea in one line, ask about what's still missing, not what they already gave you. Ask one or two focused questions per turn. If they don't know what they want, offer two or three concrete options shaped to what they've said so far.

You need, at minimum, before the story can begin: a Setting, a Register (content boundaries and tone), a PC (the user's character), and at least one other entry (an NPC or Location) for them to interact with. Call the upsert_worldbook_entry tool as soon as you have enough for an entry — don't wait until the whole conversation is done. Calling it again with the same entryType and name updates that entry; new fields merge into what's already there.

Entry types and their fields:
${describeSchemas()}

Only create an entry for something the model wouldn't already know or that needs a specific decision for this game — a generic "shopkeeper" doesn't need an entry, "the fence who's been laundering money through the PC's family business for a decade" does.

Ask directly about content boundaries once the basic shape is clear: what's welcome, what's off the table, what tone should dominate. This is freeform adult roleplay — be specific enough that it actually configures the Author.

Never say an entry is created, saved, updated, or "locked in" unless you are calling upsert_worldbook_entry in that same turn. The user only sees what actually lands in the tool call — a claim without a matching call leaves the worldbook exactly as it was, and the user has no way to tell from your words alone.

When the user says they're ready, or you judge there's enough to begin, tell them so plainly. Don't narrate scenes yourself — that's the Author's job once the story starts.`;

const UPSERT_WORLDBOOK_TOOL: ToolDefinition = {
  name: "upsert_worldbook_entry",
  description:
    "Create a new worldbook entry, or update an existing one (matched by entryType + name, or by isPc for the PC). New fields merge into any existing ones rather than replacing the whole entry.",
  parameters: {
    type: "object",
    properties: {
      entryType: { type: "string", enum: ENTRY_TYPES, description: "Which schema this entry uses." },
      name: { type: "string", description: "Display name — a person's name, a place's name, or a short label like \"Setting\"." },
      isPc: {
        type: "boolean",
        description: "Only meaningful when entryType is 'character' — true if this is the player's character, not an NPC.",
      },
      fields: {
        type: "object",
        description:
          "Field values for this entry type. Keys must be the exact lowercase key listed for that type (the part before the parenthesized label), e.g. \"offTable\" not \"Off the table\".",
        additionalProperties: { type: "string" },
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Tag names to attach to this entry (letters only, no spaces or punctuation). Existing tags are reused; new ones are created.",
      },
    },
    required: ["entryType", "name", "fields"],
  },
};

function findExistingEntry(
  db: Database.Database,
  worldbookBookId: string,
  entryType: WorldbookEntryType,
  isPc: boolean,
  name: string
): WorldbookEntry | null {
  const entries = listWorldbookEntries(db, worldbookBookId, { includeHidden: true });
  if (entryType === "setting") return entries.find((e) => e.entryType === "setting") ?? null;
  if (entryType === "register") return entries.find((e) => e.entryType === "register") ?? null;
  if (entryType === "character" && isPc) return entries.find((e) => e.isPc) ?? null;
  return entries.find((e) => e.entryType === entryType && e.name.toLowerCase() === name.toLowerCase()) ?? null;
}

function ensureTagsAttached(
  db: Database.Database,
  tagScopeBookId: string,
  tagNames: string[],
  worldbookPageId: string
): string[] {
  const warnings: string[] = [];
  const existing = listTags(db, tagScopeBookId);
  for (const raw of tagNames) {
    const name = raw.trim();
    if (!isValidTagName(name)) {
      warnings.push(`skipped invalid tag "${raw}" (letters only)`);
      continue;
    }
    const found = existing.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (!found) {
      try {
        const tag = createTag(db, { bookId: tagScopeBookId, name, worldbookPageId });
        reindexTagAcrossBook(db, tag.id);
        existing.push(tag);
      } catch (err) {
        warnings.push(`failed to create tag "${name}": ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }
    if (found.worldbookPageId !== worldbookPageId) {
      setTagWorldbookPage(db, found.id, worldbookPageId);
    }
  }
  return warnings;
}

/**
 * The tool description gives the model human-readable field labels ("Identity", "Off the
 * table"), and models reliably mirror that casing/wording back as JSON keys rather than the
 * schema's actual camelCase keys ("identity", "offTable") — confirmed empirically 2026-07-01:
 * every field from a real setup conversation came back capitalized. Without this, those values
 * would silently fail to match WORLDBOOK_FIELD_SCHEMAS lookups in both prompt assembly and the
 * Lore UI's edit form — present in the DB but invisible everywhere they're read. Matches
 * case-insensitively against both the real key and the label; anything that matches neither is
 * dropped and reported back to the model as a warning rather than silently discarded.
 */
function normalizeFields(entryType: WorldbookEntryType, rawFields: Record<string, unknown>): { fields: Record<string, string>; warnings: string[] } {
  const schema = WORLDBOOK_FIELD_SCHEMAS[entryType];
  const fields: Record<string, string> = {};
  const warnings: string[] = [];
  for (const [rawKey, rawValue] of Object.entries(rawFields)) {
    if (typeof rawValue !== "string" || !rawValue.trim()) continue;
    const match = schema.find((f) => f.key.toLowerCase() === rawKey.toLowerCase() || f.label.toLowerCase() === rawKey.toLowerCase());
    if (!match) {
      warnings.push(`unrecognized field "${rawKey}" for entryType "${entryType}" — ignored`);
      continue;
    }
    fields[match.key] = rawValue;
  }
  return { fields, warnings };
}

function executeUpsertWorldbookEntry(
  db: Database.Database,
  worldbookBookId: string,
  tagScopeBookId: string,
  rawArgs: Record<string, unknown>
): string {
  const entryType = rawArgs.entryType as WorldbookEntryType;
  const name = typeof rawArgs.name === "string" ? rawArgs.name.trim() : "";
  if (!ENTRY_TYPES.includes(entryType)) {
    return JSON.stringify({ ok: false, error: `invalid entryType "${String(rawArgs.entryType)}"` });
  }
  if (!name) return JSON.stringify({ ok: false, error: "name is required" });

  const rawFields = typeof rawArgs.fields === "object" && rawArgs.fields !== null ? (rawArgs.fields as Record<string, unknown>) : {};
  const { fields, warnings: fieldWarnings } = normalizeFields(entryType, rawFields);
  const isPc = entryType === "character" && rawArgs.isPc === true;
  const tags = Array.isArray(rawArgs.tags) ? rawArgs.tags.filter((t): t is string => typeof t === "string") : [];

  try {
    const existing = findExistingEntry(db, worldbookBookId, entryType, isPc, name);
    const entry = existing
      ? updateWorldbookEntry(db, existing.pageId, { fields: { ...existing.fields, ...fields } })
      : createWorldbookEntry(db, { bookId: worldbookBookId, entryType, isPc, name, fields });

    const tagWarnings = tags.length ? ensureTagsAttached(db, tagScopeBookId, tags, entry.pageId) : [];
    return JSON.stringify({ ok: true, pageId: entry.pageId, created: !existing, warnings: [...fieldWarnings, ...tagWarnings] });
  } catch (err) {
    return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

const MAX_TOOL_ITERATIONS = 5;

/**
 * Runs one Editor turn of the setup conversation, looping through tool calls
 * (create/update worldbook entries, attach tags) until the model responds
 * with plain text instead of a tool call. This is the "auto" tool-choice
 * counterpart to the forced-tool pattern used elsewhere — the model decides
 * per-turn whether it has enough to act, per loremaster.md's Tool Use section.
 */
export async function runEditorSetupTurn(
  db: Database.Database,
  worldbookBookId: string,
  tagScopeBookId: string,
  conversation: ChatMessage[]
): Promise<string> {
  const messages: ChatMessage[] = [{ role: "system", content: EDITOR_SETUP_SYSTEM_PROMPT }, ...conversation];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const result = await withModelFallback(getAgentProfile("editor"), (profile) =>
      callWithTools(profile, messages, [UPSERT_WORLDBOOK_TOOL])
    );
    if (!result.toolCalls.length) {
      return result.content?.trim() || "(no response)";
    }
    messages.push({ role: "assistant", content: result.content, toolCalls: result.toolCalls });
    for (const call of result.toolCalls) {
      const output =
        call.name === "upsert_worldbook_entry"
          ? executeUpsertWorldbookEntry(db, worldbookBookId, tagScopeBookId, call.arguments)
          : JSON.stringify({ ok: false, error: `unknown tool "${call.name}"` });
      messages.push({ role: "tool", toolCallId: call.id, content: output });
    }
  }
  return "(Made several worldbook updates but ran out of turns before summarizing — check the worldbook panel for what changed.)";
}
